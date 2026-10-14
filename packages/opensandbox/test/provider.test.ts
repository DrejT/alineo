import { afterEach, describe, expect, it, vi } from "vitest";
import { isAlineoError } from "@alineo-labs/errors";
import { ControlClient } from "../src/control.ts";
import { OpenSandboxProvider, phaseOf, snapshotPhaseOf } from "../src/provider.ts";
import { SandboxState, SnapshotState } from "../src/types.ts";

function controlWith(methods: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return Object.assign(
    new ControlClient({ baseUrl: "http://control.invalid", apiKey: "" }),
    methods,
  ) as ControlClient;
}

describe("phaseOf", () => {
  it.each([
    [SandboxState.Pending, "provisioning"],
    [SandboxState.Running, "running"],
    [SandboxState.Pausing, "pausing"],
    [SandboxState.Paused, "paused"],
    [SandboxState.Resuming, "resuming"],
    [SandboxState.Stopping, "stopping"],
    [SandboxState.Terminated, "terminated"],
    [SandboxState.Failed, "failed"],
  ])("maps %s to %s", (state, phase) => {
    expect(phaseOf(state)).toBe(phase);
  });

  it("maps Unknown to provisioning, never running", () => {
    expect(phaseOf(SandboxState.Unknown)).toBe("provisioning");
  });

  it("maps a state added after this was written to provisioning, never running", () => {
    expect(phaseOf("Hibernating")).toBe("provisioning");
  });
});

describe("snapshotPhaseOf", () => {
  it("treats every in-flight state as pending", () => {
    expect(snapshotPhaseOf(SnapshotState.Pending)).toBe("pending");
    expect(snapshotPhaseOf(SnapshotState.Committing)).toBe("pending");
    expect(snapshotPhaseOf(SnapshotState.Pushing)).toBe("pending");
  });

  it("maps the two final states", () => {
    expect(snapshotPhaseOf(SnapshotState.Ready)).toBe("ready");
    expect(snapshotPhaseOf(SnapshotState.Failed)).toBe("failed");
  });
});

describe("OpenSandboxProvider control calls", () => {
  it("returns a phase and keeps the provider's own state word", async () => {
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
      phase: "terminated",
      state: "Terminated",
      message: "exited 137",
      createdAt: "2026-10-14T00:00:00Z",
      metadata: { runId: "r1" },
    });
  });

  it("flattens a snapshot to a phase", async () => {
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
      phase: "pending",
      createdAt: "t",
    });
  });

  it("translates a phase filter into the server's state filter", async () => {
    const listSandboxes = vi.fn().mockResolvedValue([]);
    const provider = new OpenSandboxProvider({
      baseUrl: "http://x",
      control: controlWith({ listSandboxes }),
    });

    await provider.listSandboxes({ phase: "running", limit: 5 });

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
