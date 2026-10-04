import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LedgerEvent,
  type IStorageAdapter,
  type LedgerEntry,
  type SandboxHandle,
} from "@alineo-labs/core";
import { findLatestCheckpoint, restoreCheckpoint } from "../src/restore";

function entry(event: LedgerEvent, payload: unknown, ts: number): LedgerEntry {
  return { ts, name: "agent", sandboxId: "sb-1", stepIndex: -1, event, payload };
}

function fakeAdapter(entries: LedgerEntry[]): IStorageAdapter {
  // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial: findLatestCheckpoint only calls adapter.readAll()
  return { readAll: async () => entries } as unknown as IStorageAdapter;
}

describe("findLatestCheckpoint", () => {
  it("returns undefined when the agent was never checkpointed", async () => {
    const adapter = fakeAdapter([entry(LedgerEvent.AgentCheckpointed, undefined, 1)].slice(0, 0));
    expect(await findLatestCheckpoint(adapter, "agent", "sb-1")).toBeUndefined();
  });

  it("returns the latest checkpoint when several exist, not the first", async () => {
    const adapter = fakeAdapter([
      entry(LedgerEvent.AgentCheckpointed, { turn: 1, snapshotRef: "/a/1.tar.gz" }, 1),
      entry(LedgerEvent.AgentCheckpointed, { turn: 2, snapshotRef: "/a/2.tar.gz" }, 2),
      entry(LedgerEvent.AgentCheckpointed, { turn: 3, snapshotRef: "/a/3.tar.gz" }, 3),
    ]);
    expect(await findLatestCheckpoint(adapter, "agent", "sb-1")).toEqual({
      turn: 3,
      snapshotRef: "/a/3.tar.gz",
    });
  });

  it("ignores every other event type mixed into the same ledger", async () => {
    const adapter = fakeAdapter([
      entry(LedgerEvent.PermissionRequested, { requestId: "r1" }, 1),
      entry(LedgerEvent.AgentCheckpointed, { turn: 1, snapshotRef: "/a/1.tar.gz" }, 2),
      entry(LedgerEvent.PermissionResolved, { requestId: "r1", decision: "once" }, 3),
    ]);
    expect(await findLatestCheckpoint(adapter, "agent", "sb-1")).toEqual({
      turn: 1,
      snapshotRef: "/a/1.tar.gz",
    });
  });
});

describe("restoreCheckpoint", () => {
  it("uploads the tarball bytes and extracts them into the sandbox, byte-safe end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-test-"));
    const tarPath = join(dir, "checkpoint.tar.gz");
    const original = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x42]); // not valid UTF-8
    writeFileSync(tarPath, original);

    const uploaded: Array<{ path: string; bytes: Uint8Array }> = [];
    const execCalls: string[] = [];
    // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial: restoreCheckpoint only calls writeFileBytes/exec
    const sb = {
      writeFileBytes: async (path: string, bytes: Uint8Array) => {
        uploaded.push({ path, bytes });
      },
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as SandboxHandle;

    await restoreCheckpoint(sb, tarPath);

    expect(uploaded).toHaveLength(1);
    expect([...uploaded[0]!.bytes]).toEqual([...original]);
    expect(execCalls[0]).toContain("tar xzf");
    expect(execCalls[0]).toContain(uploaded[0]!.path);
    expect(execCalls.some((c) => c.startsWith("rm -f"))).toBe(true);
  });
});
