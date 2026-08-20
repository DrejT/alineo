import { describe, expect, it, vi, beforeEach } from "vitest";
import { Sandbox } from "../src/client.ts";
import { Environment } from "../src/environment.ts";
import { SandboxState } from "@alineo-labs/opensandbox";
import { SandboxStatus, type IStorageAdapter, type SandboxDetails } from "@alineo-labs/core";

function makeAdapter(overrides: Partial<IStorageAdapter> = {}): IStorageAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue([]),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeClient(adapter: IStorageAdapter, opts: { maxConcurrency?: number } = {}) {
  return new Sandbox({
    baseUrl: "http://localhost:8080",
    adapter,
    ...opts,
  });
}

// ── lazy connect ───────────────────────────────────────────────────────────

describe("Sandbox lazy connect", () => {
  it("does not call adapter.connect before first use", () => {
    const adapter = makeAdapter();
    makeClient(adapter);
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("calls adapter.connect exactly once across concurrent first uses", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    // Trigger two concurrent first uses
    await Promise.all([client.sandboxes.list(), client.sandboxes.list()]);
    expect(adapter.connect).toHaveBeenCalledOnce();
  });
});

// ── sessions delegation ────────────────────────────────────────────────────

describe("Sandbox.sandboxes", () => {
  let adapter: IStorageAdapter;
  let client: Sandbox;

  beforeEach(() => {
    adapter = makeAdapter();
    client = makeClient(adapter);
  });

  it("sessions.list() delegates to listAllSandboxDetails()", async () => {
    const details: SandboxDetails[] = [
      {
        name: "ci",
        sandboxId: "s1",
        status: SandboxStatus.Completed,
        startedAt: 1000,
        execCount: 2,
      },
    ];
    (adapter.listAllSandboxDetails as ReturnType<typeof vi.fn>).mockResolvedValue(details);

    const result = await client.sandboxes.list();
    expect(adapter.listAllSandboxDetails).toHaveBeenCalledWith(undefined);
    expect(result).toEqual(details);
  });

  it("sessions.list(opts) forwards opts", async () => {
    await client.sandboxes.list({ limit: 5, status: SandboxStatus.Running });
    expect(adapter.listAllSandboxDetails).toHaveBeenCalledWith({
      limit: 5,
      status: SandboxStatus.Running,
    });
  });

  it("sessions.listByName(name) delegates to listSandboxDetails(name)", async () => {
    await client.sandboxes.listByName("ci");
    expect(adapter.listSandboxDetails).toHaveBeenCalledWith("ci", undefined);
  });

  it("sessions.listByName(name, opts) forwards opts", async () => {
    await client.sandboxes.listByName("ci", { limit: 3 });
    expect(adapter.listSandboxDetails).toHaveBeenCalledWith("ci", { limit: 3 });
  });

  it("sessions.get(name, sandboxId) delegates to getSandboxDetails()", async () => {
    const details: SandboxDetails = {
      name: "ci",
      sandboxId: "s1",
      status: SandboxStatus.Completed,
      startedAt: 1000,
      execCount: 1,
    };
    (adapter.getSandboxDetails as ReturnType<typeof vi.fn>).mockResolvedValue(details);

    const result = await client.sandboxes.get("ci", "s1");
    expect(adapter.getSandboxDetails).toHaveBeenCalledWith("ci", "s1");
    expect(result).toEqual(details);
  });

  it("sessions.get() returns null for unknown session", async () => {
    const result = await client.sandboxes.get("ci", "no-such");
    expect(result).toBeNull();
  });

  it("sessions.delete(name, sandboxId) delegates to deleteSandbox()", async () => {
    await client.sandboxes.delete("ci", "s1");
    expect(adapter.deleteSandbox).toHaveBeenCalledWith("ci", "s1");
  });
});

// ── concurrency semaphore ──────────────────────────────────────────────────

describe("Sandbox concurrency slot", () => {
  it("_acquireSlot / _releaseSlot tracks active count", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter, { maxConcurrency: 2 });

    await (client as any)._acquireSlot();
    expect((client as any)._activeCount).toBe(1);

    await (client as any)._acquireSlot();
    expect((client as any)._activeCount).toBe(2);

    (client as any)._releaseSlot();
    expect((client as any)._activeCount).toBe(1);
  });

  it("third acquire blocks until a slot is released", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter, { maxConcurrency: 2 });

    await (client as any)._acquireSlot();
    await (client as any)._acquireSlot();

    let resolved = false;
    const pending = (client as any)._acquireSlot().then(() => {
      resolved = true;
    });

    // Not yet resolved — no free slot
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release one slot — pending acquire should resolve
    (client as any)._releaseSlot();
    await pending;
    expect(resolved).toBe(true);
  });

  it("no concurrency limit allows unlimited slots", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter); // no maxConcurrency

    for (let i = 0; i < 10; i++) {
      await (client as any)._acquireSlot();
    }
    expect((client as any)._activeCount).toBe(10);
  });
});

// ── environment factory ────────────────────────────────────────────────────

describe("Sandbox.environment()", () => {
  it("returns an Environment instance with the given name", () => {
    const client = makeClient(makeAdapter());
    const env = client.environment("py", {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    });
    expect(env).toBeInstanceOf(Environment);
    expect(env.name).toBe("py");
  });
});

// ── Environment.info() ────────────────────────────────────────────────────

describe("Environment.info()", () => {
  it("delegates to adapter.getEnvironment and returns the record", async () => {
    const record = { name: "py", snapshotId: "snap-1", image: "debian:slim", builtAt: 1000 };
    const adapter = makeAdapter({ getEnvironment: vi.fn().mockResolvedValue(record) });
    const client = makeClient(adapter);
    const env = client.environment("py", {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    });

    const result = await env.info();
    expect(adapter.getEnvironment).toHaveBeenCalledWith("py");
    expect(result).toEqual(record);
  });

  it("returns null when no record exists", async () => {
    const adapter = makeAdapter({ getEnvironment: vi.fn().mockResolvedValue(null) });
    const client = makeClient(adapter);
    const env = client.environment("py", {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    });

    expect(await env.info()).toBeNull();
  });
});

// ── environments namespace ─────────────────────────────────────────────────

describe("Sandbox.environments", () => {
  it("list() delegates to adapter.listEnvironments()", async () => {
    const records = [
      { name: "py", snapshotId: "snap-1", image: "debian:slim", builtAt: 2000 },
      { name: "node", snapshotId: "snap-2", image: "node:22", builtAt: 1000 },
    ];
    const adapter = makeAdapter({ listEnvironments: vi.fn().mockResolvedValue(records) });
    const client = makeClient(adapter);

    const result = await client.environments.list();
    expect(adapter.listEnvironments).toHaveBeenCalled();
    expect(result).toEqual(records);
  });

  it("delete() delegates to adapter.deleteEnvironment()", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);

    await client.environments.delete("py");
    expect(adapter.deleteEnvironment).toHaveBeenCalledWith("py");
  });
});

// ── _getOrBuildEnvironment concurrency guard ──────────────────────────────

describe("Sandbox._getOrBuildEnvironment concurrency guard", () => {
  it("concurrent calls share a single build promise", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);

    let resolveBuild!: (id: string) => void;
    const buildPromise = new Promise<string>((r) => {
      resolveBuild = r;
    });
    const buildSpy = vi.fn().mockReturnValue(buildPromise);
    (client as any)._buildEnvironment = buildSpy;

    const opts = {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    };

    const p1 = (client as any)._getOrBuildEnvironment("py", opts);
    const p2 = (client as any)._getOrBuildEnvironment("py", opts);

    // Both promises are the same object — build was invoked only once
    expect(buildSpy).toHaveBeenCalledTimes(1);

    resolveBuild("snap-1");
    expect(await p1).toBe("snap-1");
    expect(await p2).toBe("snap-1");
  });

  it("after a build completes, a new call starts a fresh build", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);

    const buildSpy = vi.fn().mockResolvedValue("snap-1");
    (client as any)._buildEnvironment = buildSpy;

    const opts = {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    };

    await (client as any)._getOrBuildEnvironment("py", opts);
    await (client as any)._getOrBuildEnvironment("py", opts);

    expect(buildSpy).toHaveBeenCalledTimes(2);
  });
});

// ── fork() wiring ──────────────────────────────────────────────────────────
//
// `SandboxHandle.fork()` throws unless the deps object it was constructed with
// includes a `fork` closure — `client.sandbox()` and `client.resume()` always
// wire one up, but `restoreSnapshot()` and `connect()` each had their own gap
// (found live: `Alineo.spawn()`, built on top of `sb.fork()`, threw "fork() is
// not supported on this sandbox" for any agent loaded via its snapshot fast
// path, or attached to via `Alineo.attach()`). Regression coverage for both.

function makeFakeControl(overrides: Record<string, unknown> = {}) {
  return {
    createSandbox: vi.fn().mockResolvedValue({ id: "new-id" }),
    getSandbox: vi.fn().mockResolvedValue({ status: { state: SandboxState.Running } }),
    ...overrides,
  };
}

describe("Sandbox.restoreSnapshot() fork wiring", () => {
  it("wires a working fork() closure onto the restored SandboxHandle", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    (client as any)._control = makeFakeControl();

    const sb = await client.restoreSnapshot("snap-1", "my-agent", {
      cpu: "500m",
      memory: "256Mi",
    });

    expect(typeof (sb as any).deps.fork).toBe("function");
  });
});

describe("Sandbox.connect() fork wiring", () => {
  it("does not wire fork() when no resources are given", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    (client as any)._control = makeFakeControl();

    const sb = await client.connect("sandbox-1", "my-agent");

    expect((sb as any).deps.fork).toBeUndefined();
  });

  it("wires a working fork() closure when resources are given", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    (client as any)._control = makeFakeControl();

    const sb = await client.connect("sandbox-1", "my-agent", {
      resources: { cpu: "500m", memory: "256Mi" },
    });

    expect(typeof (sb as any).deps.fork).toBe("function");
  });
});
