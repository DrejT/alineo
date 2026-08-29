import { describe, expect, it, vi } from "vitest";
import { SandboxHandle } from "../src/sandbox/index.ts";
import { SandboxError } from "../src/errors.ts";
import { SnapshotState } from "@alineo-labs/opensandbox";
import type { SandboxDeps } from "../src/sandbox/index.ts";
import type { IStorageAdapter, LedgerEntry } from "../src/ledger.ts";
import { LedgerEvent } from "../src/ledger.ts";

function makeAdapter(): IStorageAdapter {
  return {
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
  };
}

function makeControl(snapshotId = "snap-abc") {
  return {
    createSnapshot: vi.fn().mockResolvedValue({ id: snapshotId }),
    getSnapshot: vi.fn().mockResolvedValue({ state: SnapshotState.Ready }),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

function asControl(control: ReturnType<typeof makeControl>): SandboxDeps["control"] {
  return control as unknown as SandboxDeps["control"];
}

function makeDeps(adapter: IStorageAdapter, overrides: Partial<SandboxDeps> = {}): SandboxDeps {
  return {
    control: asControl(makeControl()),
    adapter,
    ...overrides,
  };
}

function appendedEntries(adapter: IStorageAdapter): LedgerEntry[] {
  return (adapter.append as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as LedgerEntry);
}

describe("SandboxHandle.fork()", () => {
  it("calls createSnapshot and emits checkpoint_created before invoking the fork dep", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const control = makeControl("snap-xyz");

    const sb = new SandboxHandle("sb-1", "test", {
      control: asControl(control),
      adapter,
      fork: forkFn,
    });

    await sb.fork();

    expect(control.createSnapshot).toHaveBeenCalledWith("sb-1");

    const entries = appendedEntries(adapter);
    const events = entries.map((e) => e.event);
    expect(events).toContain(LedgerEvent.CheckpointCreated);

    const cpEntry = entries.find((e) => e.event === LedgerEvent.CheckpointCreated);
    expect((cpEntry?.payload as { snapshotId: string } | undefined)?.snapshotId).toBe("snap-xyz");

    expect(forkFn).toHaveBeenCalledWith("snap-xyz", undefined, undefined, {
      networkPolicy: undefined,
      credentialProxy: false,
    });
  });

  it("passes the tag to the fork dep and stores it in the checkpoint payload", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const control = makeControl("snap-tagged");

    const sb = new SandboxHandle("sb-1", "test", {
      control: asControl(control),
      adapter,
      fork: forkFn,
    });

    await sb.fork("after-install");

    expect(forkFn).toHaveBeenCalledWith("snap-tagged", "after-install", undefined, {
      networkPolicy: undefined,
      credentialProxy: false,
    });

    const cpEntry = appendedEntries(adapter).find((e) => e.event === LedgerEvent.CheckpointCreated);
    expect((cpEntry?.payload as { name?: string } | undefined)?.name).toBe("after-install");
  });

  it("returns the SandboxHandle returned by the fork dep", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);

    const sb = new SandboxHandle("sb-1", "test", {
      control: asControl(makeControl()),
      adapter,
      fork: forkFn,
    });

    const result = await sb.fork();
    expect(result).toBe(forkedSandbox);
  });

  it("throws SandboxError when no fork dep is provided", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));

    await expect(sb.fork()).rejects.toThrow(SandboxError);
    await expect(sb.fork()).rejects.toThrow("fork() is not supported on this sandbox");
  });

  it("passes resourceId/teamId overrides through to the fork dep", async () => {
    // Without these reaching the dep, a forked child would always silently inherit
    // whatever this sandbox's own creation closed over instead of getting its own identity —
    // the bug `Alineo.spawn()` needs this override to avoid.
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);

    const sb = new SandboxHandle("sb-1", "test", {
      control: makeControl() as any,
      adapter,
      fork: forkFn,
    });

    await sb.fork(undefined, undefined, { resourceId: "child-resource", teamId: "acme" });

    expect(forkFn).toHaveBeenCalledWith("snap-abc", undefined, undefined, {
      networkPolicy: undefined,
      credentialProxy: false,
      resourceId: "child-resource",
      teamId: "acme",
    });
  });

  it("omits resourceId/teamId (undefined) when no override is given, letting the dep inherit", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);

    const sb = new SandboxHandle("sb-1", "test", {
      control: makeControl() as any,
      adapter,
      fork: forkFn,
    });

    await sb.fork();

    const [, , , opts] = forkFn.mock.calls[0]!;
    expect(opts.resourceId).toBeUndefined();
    expect(opts.teamId).toBeUndefined();
  });

  it("fires the onCheckpoint hook with the snapshot ID and tag", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new SandboxHandle("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const onCheckpoint = vi.fn();

    const sb = new SandboxHandle("sb-1", "test", {
      control: asControl(makeControl("snap-hook")),
      adapter,
      hooks: { onCheckpoint },
      fork: forkFn,
    });

    await sb.fork("my-tag");

    expect(onCheckpoint).toHaveBeenCalledWith("sb-1", "snap-hook", "my-tag");
  });
});
