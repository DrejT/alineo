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
  takeCheckpoint,
} from "../src/checkpoint";

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
