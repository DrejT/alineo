import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox/index.ts";
import { SandboxError } from "../src/errors.ts";
import { SnapshotState } from "@alineo-labs/opensandbox";
import type { SandboxDeps } from "../src/sandbox/index.ts";
import type { IStorageAdapter } from "../src/ledger.ts";
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

function makeDeps(adapter: IStorageAdapter, overrides: Partial<SandboxDeps> = {}): SandboxDeps {
  return {
    control: makeControl() as any,
    adapter,
    ...overrides,
  };
}

describe("Sandbox.fork()", () => {
  it("calls createSnapshot and emits checkpoint_created before invoking the fork dep", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new Sandbox("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const control = makeControl("snap-xyz");

    const sb = new Sandbox("sb-1", "test", {
      control: control as any,
      adapter,
      fork: forkFn,
    });

    await sb.fork();

    expect(control.createSnapshot).toHaveBeenCalledWith("sb-1");

    const appendCalls = (adapter.append as ReturnType<typeof vi.fn>).mock.calls;
    const events = appendCalls.map((c: [{ event: string }]) => c[0].event);
    expect(events).toContain(LedgerEvent.CheckpointCreated);

    const cpEntry = appendCalls.find(
      (c: [{ event: string }]) => c[0].event === LedgerEvent.CheckpointCreated,
    );
    expect((cpEntry![0] as any).payload.snapshotId).toBe("snap-xyz");

    expect(forkFn).toHaveBeenCalledWith("snap-xyz", undefined, undefined);
  });

  it("passes the tag to the fork dep and stores it in the checkpoint payload", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new Sandbox("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const control = makeControl("snap-tagged");

    const sb = new Sandbox("sb-1", "test", {
      control: control as any,
      adapter,
      fork: forkFn,
    });

    await sb.fork("after-install");

    expect(forkFn).toHaveBeenCalledWith("snap-tagged", "after-install", undefined);

    const appendCalls = (adapter.append as ReturnType<typeof vi.fn>).mock.calls;
    const cpEntry = appendCalls.find(
      (c: [{ event: string }]) => c[0].event === LedgerEvent.CheckpointCreated,
    );
    expect((cpEntry![0] as any).payload.name).toBe("after-install");
  });

  it("returns the Sandbox returned by the fork dep", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new Sandbox("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);

    const sb = new Sandbox("sb-1", "test", {
      control: makeControl() as any,
      adapter,
      fork: forkFn,
    });

    const result = await sb.fork();
    expect(result).toBe(forkedSandbox);
  });

  it("throws SandboxError when no fork dep is provided", async () => {
    const adapter = makeAdapter();
    const sb = new Sandbox("sb-1", "test", makeDeps(adapter));

    await expect(sb.fork()).rejects.toThrow(SandboxError);
    await expect(sb.fork()).rejects.toThrow("fork() is not supported on this sandbox");
  });

  it("fires the onCheckpoint hook with the snapshot ID and tag", async () => {
    const adapter = makeAdapter();
    const forkedSandbox = new Sandbox("forked-id", "fork-sb-abc12345", makeDeps(adapter));
    const forkFn = vi.fn().mockResolvedValue(forkedSandbox);
    const onCheckpoint = vi.fn();

    const sb = new Sandbox("sb-1", "test", {
      control: makeControl("snap-hook") as any,
      adapter,
      hooks: { onCheckpoint },
      fork: forkFn,
    });

    await sb.fork("my-tag");

    expect(onCheckpoint).toHaveBeenCalledWith("sb-1", "snap-hook", "my-tag");
  });
});
