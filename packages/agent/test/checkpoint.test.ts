import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, LedgerEvent, type SandboxHandle } from "@alineo-labs/core";
import {
  CHECKPOINT_ROOT,
  DEFAULT_CHECKPOINT_EXCLUDES,
  DEFAULT_CHECKPOINT_RETENTION,
  checkpointsPath,
  pruneRemoteCheckpoints,
  takeCheckpoint,
} from "../src/checkpoint";
import { MemoryBlobStore, type BlobStore } from "../src/blob-store";

function fakeSandbox(
  opts: { sandboxId?: string; execExitCode?: number; bytes?: Uint8Array } = {},
): {
  sb: SandboxHandle;
  execCalls: string[];
  emitted: Array<{ event: LedgerEvent; payload: unknown }>;
} {
  const execCalls: string[] = [];
  const emitted: Array<{ event: LedgerEvent; payload: unknown }> = [];
  // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial: takeCheckpoint only calls exec/readFileBytes/emit/sandboxId
  const sb = {
    sandboxId: opts.sandboxId ?? "sb-1",
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (opts.execExitCode && opts.execExitCode !== 0) {
        throw new CommandError(opts.execExitCode, cmd, opts.sandboxId ?? "sb-1");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    readFileBytes: async (_path: string) =>
      opts.bytes ?? new TextEncoder().encode("fake-tar-bytes"),
    emit: async (event: LedgerEvent, _stepIndex: number, payload: unknown) => {
      emitted.push({ event, payload });
    },
  } as unknown as SandboxHandle;
  return { sb, execCalls, emitted };
}

describe("checkpointsPath", () => {
  it("derives a sibling 'checkpoints' directory from the ledger adapter's own path", () => {
    expect(checkpointsPath("/data/ledger.db")).toBe("/data/checkpoints");
  });
});

describe("takeCheckpoint", () => {
  it("also tars /workspace when it exists, leaving node_modules out of it only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, execCalls } = fakeSandbox();

    await takeCheckpoint(sb, dir, { turn: 1 });

    expect(execCalls[0]).toContain("[ -d /workspace ] && echo workspace");
    expect(execCalls[0]).toContain("--exclude=workspace/node_modules");
    expect(execCalls[0]).toContain("--exclude=workspace/*/node_modules");
    // Not a blanket exclude: under /root, node_modules can hold Pi's own packages.
    expect(execCalls[0]).not.toContain("--exclude=*/node_modules");
  });

  it("tars CHECKPOINT_ROOT with the default excludes, writes bytes to disk, and emits AgentCheckpointed only after the write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, execCalls, emitted } = fakeSandbox();

    const record = await takeCheckpoint(sb, dir, { turn: 1 });

    expect(execCalls[0]).toContain("tar czf");
    expect(execCalls[0]).toContain(CHECKPOINT_ROOT);
    for (const ex of DEFAULT_CHECKPOINT_EXCLUDES) {
      expect(execCalls[0]).toContain(`--exclude=${CHECKPOINT_ROOT}/${ex}`);
    }
    expect(existsSync(record.snapshotRef)).toBe(true);
    expect(readFileSync(record.snapshotRef, "utf-8")).toBe("fake-tar-bytes");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: LedgerEvent.AgentCheckpointed,
      payload: { turn: 1, snapshotRef: record.snapshotRef },
    });
  });

  it("scopes the checkpoint file under the sandbox's own id, so two sandboxes never collide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const a = await takeCheckpoint(fakeSandbox({ sandboxId: "sb-a" }).sb, dir, { turn: 1 });
    const b = await takeCheckpoint(fakeSandbox({ sandboxId: "sb-b" }).sb, dir, { turn: 1 });
    expect(a.snapshotRef).not.toBe(b.snapshotRef);
    expect(a.snapshotRef).toContain("sb-a");
    expect(b.snapshotRef).toContain("sb-b");
  });

  it("accepts extra caller-supplied exclude globs alongside the defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, execCalls } = fakeSandbox();
    await takeCheckpoint(sb, dir, { turn: 1, excludeGlobs: ["root/node_modules"] });
    expect(execCalls[0]).toContain("--exclude=root/node_modules");
  });

  it("always cleans up the temp tar file inside the sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, execCalls } = fakeSandbox();
    await takeCheckpoint(sb, dir, { turn: 1 });
    expect(execCalls.some((c) => c.startsWith("rm -f"))).toBe(true);
  });

  it("propagates a tar failure and never writes a checkpoint event for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, emitted } = fakeSandbox({ execExitCode: 1 });
    let threw = false;
    try {
      await takeCheckpoint(sb, dir, { turn: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});

describe("checkpoint retention (M3, 3.5)", () => {
  it("keeps only the newest DEFAULT_CHECKPOINT_RETENTION files for a sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb } = fakeSandbox();
    for (let turn = 1; turn <= DEFAULT_CHECKPOINT_RETENTION + 2; turn++) {
      await takeCheckpoint(sb, dir, { turn });
    }
    const remaining = readdirSync(join(dir, sb.sandboxId));
    expect(remaining).toHaveLength(DEFAULT_CHECKPOINT_RETENTION);
  });

  it("respects a caller-supplied retain count instead of the default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb } = fakeSandbox();
    for (let turn = 1; turn <= 5; turn++) {
      await takeCheckpoint(sb, dir, { turn, retain: 1 });
    }
    const remaining = readdirSync(join(dir, sb.sandboxId));
    expect(remaining).toHaveLength(1);
  });

  it("never prunes below the count while under the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb } = fakeSandbox();
    await takeCheckpoint(sb, dir, { turn: 1 });
    await takeCheckpoint(sb, dir, { turn: 2 });
    const remaining = readdirSync(join(dir, sb.sandboxId));
    expect(remaining).toHaveLength(2);
  });

  it("keeps each sandbox's own checkpoints independent of another's retention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const a = fakeSandbox({ sandboxId: "sb-a" }).sb;
    const b = fakeSandbox({ sandboxId: "sb-b" }).sb;
    for (let turn = 1; turn <= DEFAULT_CHECKPOINT_RETENTION + 2; turn++) {
      await takeCheckpoint(a, dir, { turn });
    }
    await takeCheckpoint(b, dir, { turn: 1 });
    expect(readdirSync(join(dir, "sb-a"))).toHaveLength(DEFAULT_CHECKPOINT_RETENTION);
    expect(readdirSync(join(dir, "sb-b"))).toHaveLength(1);
  });
});

describe("takeCheckpoint with an off-box store (M4, 4.1)", () => {
  it("uploads the same bytes before it emits, and records both references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const store = new MemoryBlobStore();
    const { sb, emitted } = fakeSandbox({ sandboxId: "sb-up" });

    const record = await takeCheckpoint(sb, dir, { turn: 2, blobStore: store });

    expect(store.keys()).toHaveLength(1);
    expect(store.keys()[0]).toMatch(/^sb-up\/2-\d+\.tar\.gz$/);
    expect(new TextDecoder().decode(await store.get(store.keys()[0]!))).toBe("fake-tar-bytes");
    expect(record.remoteRef).toBe(store.refOf(store.keys()[0]!));
    expect(record.uploadError).toBeUndefined();
    // The host copy is kept (decision D5) and is still the snapshotRef.
    expect(existsSync(record.snapshotRef)).toBe(true);
    expect(emitted[0]!.payload).toEqual({
      turn: 2,
      snapshotRef: record.snapshotRef,
      remoteRef: record.remoteRef,
    });
  });

  it("does not fail the checkpoint when the upload fails, and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const broken: BlobStore = {
      put: () => Promise.reject(new Error("bucket unreachable")),
      get: () => Promise.reject(new Error("bucket unreachable")),
      delete: () => Promise.reject(new Error("bucket unreachable")),
      list: () => Promise.resolve([]),
      refOf: (k) => `mem://${k}`,
      keyOf: () => undefined,
    };
    const { sb, emitted } = fakeSandbox();

    const record = await takeCheckpoint(sb, dir, { turn: 1, blobStore: broken });

    expect(record.remoteRef).toBeUndefined();
    expect(record.uploadError).toBe("bucket unreachable");
    expect(existsSync(record.snapshotRef)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({
      turn: 1,
      snapshotRef: record.snapshotRef,
      uploadError: "bucket unreachable",
    });
  });

  it("uploads before the event, so an event never names a missing blob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const order: string[] = [];
    const store = new MemoryBlobStore();
    const put = store.put.bind(store);
    store.put = async (k, b) => {
      order.push("put");
      await put(k, b);
    };
    const { sb } = fakeSandbox();
    const emit = sb.emit.bind(sb);
    sb.emit = async (...args: Parameters<typeof sb.emit>) => {
      order.push("emit");
      await emit(...args);
    };

    await takeCheckpoint(sb, dir, { turn: 1, blobStore: store });

    expect(order).toEqual(["put", "emit"]);
  });

  it("leaves the payload as it was when no store is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const { sb, emitted } = fakeSandbox();

    const record = await takeCheckpoint(sb, dir, { turn: 1 });

    expect(emitted[0]!.payload).toEqual({ turn: 1, snapshotRef: record.snapshotRef });
  });
});

describe("pruneRemoteCheckpoints", () => {
  const HOUR = 3_600_000;

  async function seeded(ages: number[], now: number) {
    // Written oldest first by moving the store's clock.
    let clock = now;
    const aged = new MemoryBlobStore(() => clock);
    for (const [i, age] of ages.entries()) {
      clock = now - age;
      await aged.put(`sb-1/${i}.tar.gz`, new Uint8Array(1));
    }
    await aged.put("sb-2/0.tar.gz", new Uint8Array(1));
    return aged;
  }

  it("keeps the newest N and deletes older ones that are past the age margin", async () => {
    const now = 100 * HOUR;
    const store = await seeded([5 * HOUR, 4 * HOUR, 3 * HOUR, 2 * HOUR, 1 * HOUR], now);

    const gone = await pruneRemoteCheckpoints(store, "sb-1", {
      retain: 3,
      minAgeMs: HOUR / 2,
      now,
    });

    expect(gone.sort()).toEqual(["sb-1/0.tar.gz", "sb-1/1.tar.gz"]);
    expect(store.keys()).toEqual([
      "sb-1/2.tar.gz",
      "sb-1/3.tar.gz",
      "sb-1/4.tar.gz",
      "sb-2/0.tar.gz",
    ]);
  });

  it("never deletes a blob younger than the margin, even beyond the count", async () => {
    const now = 100 * HOUR;
    // Five blobs a minute apart: all beyond retain 2 except two, but all are younger than 10 min.
    const store = await seeded(
      [5, 4, 3, 2, 1].map((m) => m * 60_000),
      now,
    );

    const gone = await pruneRemoteCheckpoints(store, "sb-1", {
      retain: 2,
      minAgeMs: 10 * 60_000,
      now,
    });

    expect(gone).toEqual([]);
  });

  it("only touches the given sandbox", async () => {
    const now = 100 * HOUR;
    const store = await seeded([3 * HOUR, 2 * HOUR, 1 * HOUR], now);

    await pruneRemoteCheckpoints(store, "sb-1", { retain: 1, minAgeMs: 0, now });

    expect(store.keys()).toContain("sb-2/0.tar.gz");
  });
});
