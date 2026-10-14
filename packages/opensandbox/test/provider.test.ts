import { afterEach, describe, expect, it, vi } from "vitest";
import { isAlineoError } from "@alineo-labs/errors";
import { ControlClient } from "../src/control.ts";
import { CodeLanguage as ProviderCodeLanguage } from "@alineo-labs/provider";
import { CodeLanguage } from "../src/index.ts";
import { OpenSandboxProvider, stateOf, snapshotStateOf } from "../src/provider.ts";
import { SandboxState, SnapshotState } from "../src/types.ts";

function controlWith(methods: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return Object.assign(
    new ControlClient({ baseUrl: "http://control.invalid", apiKey: "" }),
    methods,
  ) as ControlClient;
}

describe("stateOf", () => {
  it.each([
    [SandboxState.Pending, "provisioning"],
    [SandboxState.Running, "running"],
    [SandboxState.Pausing, "pausing"],
    [SandboxState.Paused, "paused"],
    [SandboxState.Resuming, "resuming"],
    [SandboxState.Stopping, "stopping"],
    [SandboxState.Terminated, "terminated"],
    [SandboxState.Failed, "failed"],
  ])("maps %s to %s", (native, state) => {
    expect(stateOf(native)).toBe(state);
  });

  it("maps Unknown to provisioning, never running", () => {
    expect(stateOf(SandboxState.Unknown)).toBe("provisioning");
  });

  it("maps a state added after this was written to provisioning, never running", () => {
    expect(stateOf("Hibernating")).toBe("provisioning");
  });
});

describe("snapshotStateOf", () => {
  it("treats every in-flight state as pending", () => {
    expect(snapshotStateOf(SnapshotState.Pending)).toBe("pending");
    expect(snapshotStateOf(SnapshotState.Committing)).toBe("pending");
    expect(snapshotStateOf(SnapshotState.Pushing)).toBe("pending");
  });

  it("maps the two final states", () => {
    expect(snapshotStateOf(SnapshotState.Ready)).toBe("ready");
    expect(snapshotStateOf(SnapshotState.Failed)).toBe("failed");
  });
});

describe("OpenSandboxProvider control calls", () => {
  it("returns a neutral state and keeps the provider's own word for it", async () => {
    const provider = new OpenSandboxProvider({
      baseUrl: "http://x",
      control: controlWith({
        getSandbox: vi.fn().mockResolvedValue({
          id: "sb-1",
          status: { state: SandboxState.Terminated, message: "exited 137" },
          createdAt: "2026-10-14T00:00:00Z",
          metadata: { runId: "r1" },
        }),
      }),
    });

    expect(await provider.getSandbox("sb-1")).toEqual({
      id: "sb-1",
      state: "terminated",
      nativeState: "Terminated",
      message: "exited 137",
      createdAt: "2026-10-14T00:00:00Z",
      metadata: { runId: "r1" },
    });
  });

  it("flattens a snapshot to a state", async () => {
    const provider = new OpenSandboxProvider({
      baseUrl: "http://x",
      control: controlWith({
        createSnapshot: vi.fn().mockResolvedValue({
          id: "snap-1",
          sandboxId: "sb-1",
          state: SnapshotState.Committing,
          createdAt: "t",
        }),
      }),
    });

    expect(await provider.createSnapshot("sb-1")).toEqual({
      id: "snap-1",
      sandboxId: "sb-1",
      state: "pending",
      createdAt: "t",
    });
  });

  it("translates a state filter into the server's state filter", async () => {
    const listSandboxes = vi.fn().mockResolvedValue([]);
    const provider = new OpenSandboxProvider({
      baseUrl: "http://x",
      control: controlWith({ listSandboxes }),
    });

    await provider.listSandboxes({ state: "running", limit: 5 });

    expect(listSandboxes).toHaveBeenCalledWith({ state: SandboxState.Running, limit: 5 });
  });

  it("uses its own server-proxy setting unless a call overrides it", async () => {
    const getEndpoint = vi.fn().mockResolvedValue({ endpoint: "h:1" });
    const provider = new OpenSandboxProvider({
      baseUrl: "http://x",
      useServerProxy: true,
      control: controlWith({ getEndpoint }),
    });

    await provider.getEndpoint("sb-1", 8080);
    await provider.getEndpoint("sb-1", 8080, false);

    expect(getEndpoint).toHaveBeenNthCalledWith(1, "sb-1", 8080, true);
    expect(getEndpoint).toHaveBeenNthCalledWith(2, "sb-1", 8080, false);
  });

  it("declares what it can do, and does not claim what it cannot prove", () => {
    const { capabilities } = new OpenSandboxProvider({ baseUrl: "http://x" }).descriptor;
    expect(capabilities.snapshot).toEqual({ kind: "filesystem" });
    expect(capabilities.egress).toBe("unverified");
    expect(capabilities.credentials).toBe("unverified");
  });
});

describe("OpenSandboxProvider.connectExec", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function providerWithEndpoint(readiness = { retries: 2, delayMs: 5 }) {
    return new OpenSandboxProvider({
      baseUrl: "http://x",
      execReadiness: readiness,
      control: controlWith({
        getEndpoint: vi.fn().mockResolvedValue({ endpoint: "http://localhost:44772", headers: {} }),
      }),
    });
  }

  it("returns a channel once execd answers, after transient failures", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("ECONNREFUSED"));
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }),
    );

    const channel = await providerWithEndpoint().connectExec("sb-1");

    expect(typeof channel.executeCommand).toBe("function");
    expect(calls).toBe(3);
  });

  it("is patient by default: 40 failed probes are not too many (issue #32)", async () => {
    // The old budget was about 11 s over 16 attempts. A fork taken from a parent running a real
    // Chrome session needed about 35 s to reach Running and then used all of it. Fake timers run
    // the real backoff math without the wait.
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls++;
          if (calls < 40) return Promise.reject(new Error("ECONNREFUSED"));
          return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }),
      );
      const provider = new OpenSandboxProvider({
        baseUrl: "http://x",
        control: controlWith({
          getEndpoint: vi.fn().mockResolvedValue({ endpoint: "http://localhost:44772" }),
        }),
      });

      const pending = provider.connectExec("sb-1");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBeDefined();
      expect(calls).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with EXEC_NOT_READY and says what it saw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5")));

    const err = await providerWithEndpoint()
      .connectExec("sb-9")
      .catch((e: unknown) => e);

    expect(isAlineoError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "EXEC_NOT_READY",
      details: { sandboxId: "sb-9", attempts: 3 },
    });
    expect((err as Error).message).toMatch(/after 3 attempts over \d+s/);
    expect(((err as Error).cause as Error).message).toBe("connect ECONNREFUSED 10.0.0.5");
  });
});

describe("CodeLanguage", () => {
  it("is one definition: this package re-exports the provider's", () => {
    expect(CodeLanguage).toBe(ProviderCodeLanguage);
  });

  it("keeps the members and values the old enum had", () => {
    expect(CodeLanguage).toEqual({
      Python: "python",
      JavaScript: "javascript",
      TypeScript: "typescript",
      Go: "go",
      Java: "java",
      Bash: "bash",
    });
  });
});
