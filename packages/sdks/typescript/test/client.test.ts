import { describe, expect, it, vi, beforeEach } from "vitest";
import { Sandbox, type SandboxHandle } from "../src/client.ts";
import { Environment, type EnvironmentSandboxOptions } from "../src/environment.ts";
import { SandboxState } from "@alineo-labs/opensandbox";
import { SandboxStatus, type IStorageAdapter, type SandboxDetails } from "@alineo-labs/core";

function makeAdapter(overrides: Partial<IStorageAdapter> = {}): IStorageAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listCheckpoints: vi.fn().mockResolvedValue([]),
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

/**
 * Reaches Sandbox's private concurrency-semaphore internals for the tests below,
 * instead of `as any` at every call site. `_control` is typed `unknown` because
 * tests deliberately swap in a partial fake, not a real ControlClient.
 */
interface SandboxInternals {
  _control: unknown;
  _activeCount: number;
  _acquireSlot(): Promise<void>;
  _releaseSlot(): void;
  _createFromSnapshot(
    snapshotId: string,
    resources: { cpu: string; memory: string; gpu?: string },
    envName: string,
    envShell?: string,
    extra?: EnvironmentSandboxOptions,
  ): Promise<SandboxHandle>;
}

function internals(client: Sandbox): SandboxInternals {
  return client as unknown as SandboxInternals;
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
        runId: "s1",
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
      runId: "s1",
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

    await internals(client)._acquireSlot();
    expect(internals(client)._activeCount).toBe(1);

    await internals(client)._acquireSlot();
    expect(internals(client)._activeCount).toBe(2);

    internals(client)._releaseSlot();
    expect(internals(client)._activeCount).toBe(1);
  });

  it("third acquire blocks until a slot is released", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter, { maxConcurrency: 2 });

    await internals(client)._acquireSlot();
    await internals(client)._acquireSlot();

    let resolved = false;
    const pending = internals(client)
      ._acquireSlot()
      .then(() => {
        resolved = true;
      });

    // Not yet resolved — no free slot
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release one slot — pending acquire should resolve
    internals(client)._releaseSlot();
    await pending;
    expect(resolved).toBe(true);
  });

  it("no concurrency limit allows unlimited slots", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter); // no maxConcurrency

    for (let i = 0; i < 10; i++) {
      await internals(client)._acquireSlot();
    }
    expect(internals(client)._activeCount).toBe(10);
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
    client._buildEnvironment = buildSpy;

    const opts = {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    };

    const p1 = client._getOrBuildEnvironment("py", opts);
    const p2 = client._getOrBuildEnvironment("py", opts);

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
    client._buildEnvironment = buildSpy;

    const opts = {
      image: "debian:slim",
      resources: { cpu: "500m", memory: "256Mi" },
      setup: async () => {},
    };

    await client._getOrBuildEnvironment("py", opts);
    await client._getOrBuildEnvironment("py", opts);

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
    internals(client)._control = makeFakeControl();

    const sb = await client.restoreSnapshot("snap-1", "my-agent", {
      cpu: "500m",
      memory: "256Mi",
    });

    expect(typeof sb.deps.fork).toBe("function");
  });
});

describe("Sandbox.connect() fork wiring", () => {
  it("does not wire fork() when no resources are given", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.connect("sandbox-1", "my-agent");

    expect(sb.deps.fork).toBeUndefined();
  });

  it("wires a working fork() closure when resources are given", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.connect("sandbox-1", "my-agent", {
      resources: { cpu: "500m", memory: "256Mi" },
    });

    expect(typeof sb.deps.fork).toBe("function");
  });
});

// ── resourceId / teamId threading ───────────────────────────────────────────
//
// `resourceId` and `teamId` (see `SandboxOptions`) must reach the `sandbox_created` ledger
// payload on every creation path, and must be inherited (not dropped) by whatever `fork()`
// closure that path wires up — `@alineo-labs/memory`'s `episodicRecall()` depends on both
// being there. Every path below was previously untested; the `_createFromSnapshot()` pair
// specifically regression-tests a real bug where its fork closure hardcoded `resourceId:
// undefined` (and had no teamId support at all) unlike every other creation path.

function createdPayload(adapter: IStorageAdapter): Record<string, unknown> | undefined {
  const call = vi
    .mocked(adapter.append)
    .mock.calls.find(([entry]) => entry.event === "sandbox_created");
  return call?.[0].payload as Record<string, unknown> | undefined;
}

describe("Sandbox.sandbox() resourceId/teamId threading", () => {
  it("includes resourceId/teamId in the ledger payload and the fork closure", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.sandbox({
      image: "node:22",
      resources: { cpu: "500m", memory: "256Mi" },
      resourceId: "user-1",
      teamId: "acme",
    });
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await sb.deps.fork!("snap-1", undefined, undefined, undefined);
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });
  });
});

describe("Sandbox.resume() resourceId/teamId threading", () => {
  it("inherits resourceId/teamId from the original sandbox_created payload", async () => {
    const adapter = makeAdapter();
    (adapter.listAllSandboxDetails as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: "ci",
        sandboxId: "orig",
        status: SandboxStatus.Completed,
        startedAt: 1000,
        execCount: 0,
      },
    ]);
    (adapter.readAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ts: 1000,
        name: "ci",
        sandboxId: "orig",
        stepIndex: -1,
        event: "sandbox_created",
        payload: { resourceId: "user-1", teamId: "acme" },
      },
      {
        ts: 1001,
        name: "ci",
        sandboxId: "orig",
        stepIndex: -1,
        event: "checkpoint_created",
        payload: { snapshotId: "snap-1" },
      },
    ]);
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    await client.resume("orig");
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });
  });
});

describe("Sandbox.restoreSnapshot() resourceId/teamId threading", () => {
  it("includes resourceId/teamId in the ledger payload and the fork closure", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.restoreSnapshot(
      "snap-1",
      "my-agent",
      { cpu: "500m", memory: "256Mi" },
      undefined,
      {
        resourceId: "user-1",
        teamId: "acme",
      },
    );
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await sb.deps.fork!("snap-2", undefined, undefined, undefined);
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });
  });
});

describe("fork closure resourceId/teamId override", () => {
  // Every fork closure inherits its parent's resourceId/teamId by default (a fork is normally
  // a continuation of the same resource's memory) — but Alineo.spawn() needs a *different*
  // resource/team identity for the child, not the parent's. This is what makes that possible:
  // forkOpts.resourceId/teamId, when given, override the inherited default instead of being
  // silently ignored.
  it("overrides the inherited resourceId/teamId when forkOpts supplies them", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.sandbox({
      image: "node:22",
      resources: { cpu: "500m", memory: "256Mi" },
      resourceId: "parent-resource",
      teamId: "parent-team",
    });

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await sb.deps.fork!("snap-child", undefined, undefined, {
      resourceId: "child-resource",
      teamId: "child-team",
    });

    expect(createdPayload(adapter)).toMatchObject({
      resourceId: "child-resource",
      teamId: "child-team",
    });
  });

  it("still inherits from the parent when forkOpts omits resourceId/teamId", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await client.sandbox({
      image: "node:22",
      resources: { cpu: "500m", memory: "256Mi" },
      resourceId: "parent-resource",
      teamId: "parent-team",
    });

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await sb.deps.fork!("snap-child", undefined, undefined, undefined);

    expect(createdPayload(adapter)).toMatchObject({
      resourceId: "parent-resource",
      teamId: "parent-team",
    });
  });

  it("a second-level fork with no override inherits the first fork's identity, not the grandparent's", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const parent = await client.sandbox({
      image: "node:22",
      resources: { cpu: "500m", memory: "256Mi" },
      resourceId: "grandparent-resource",
    });
    const child = await parent.deps.fork!("snap-child", undefined, undefined, {
      resourceId: "child-resource",
    });

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await child.deps.fork!("snap-grandchild", undefined, undefined, undefined);

    expect(createdPayload(adapter)).toMatchObject({ resourceId: "child-resource" });
  });
});

describe("Sandbox._createFromSnapshot() resourceId/teamId threading (environment path)", () => {
  it("includes resourceId/teamId in the ledger payload — previously always undefined here", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    await internals(client)._createFromSnapshot(
      "snap-1",
      { cpu: "500m", memory: "256Mi" },
      "py",
      undefined,
      { resourceId: "user-1", teamId: "acme" },
    );
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });
  });

  it("wires resourceId/teamId into the fork closure instead of hardcoding undefined", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    const sb = await internals(client)._createFromSnapshot(
      "snap-1",
      { cpu: "500m", memory: "256Mi" },
      "py",
      undefined,
      { resourceId: "user-1", teamId: "acme" },
    );

    (adapter.append as ReturnType<typeof vi.fn>).mockClear();
    await sb.deps.fork!("snap-2", undefined, undefined, undefined);
    expect(createdPayload(adapter)).toMatchObject({ resourceId: "user-1", teamId: "acme" });
  });

  it("leaves resourceId/teamId undefined when extra omits them", async () => {
    const adapter = makeAdapter();
    const client = makeClient(adapter);
    internals(client)._control = makeFakeControl();

    await internals(client)._createFromSnapshot("snap-1", { cpu: "500m", memory: "256Mi" }, "py");
    const payload = createdPayload(adapter);
    expect(payload?.resourceId).toBeUndefined();
    expect(payload?.teamId).toBeUndefined();
  });
});
