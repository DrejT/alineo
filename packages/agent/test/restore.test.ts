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
import { MemoryBlobStore } from "../src/blob-store";
import {
  fetchCheckpoint,
  findCheckpoints,
  findLatestCheckpoint,
  pickRestorable,
  restoreCheckpoint,
} from "../src/restore";

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

describe("findCheckpoints", () => {
  it("lists every checkpoint, newest first, with its remote reference", async () => {
    const adapter = fakeAdapter([
      entry(LedgerEvent.AgentCheckpointed, { turn: 1, snapshotRef: "/a/1.tar.gz" }, 1),
      entry(LedgerEvent.PermissionRequested, { requestId: "r1" }, 2),
      entry(
        LedgerEvent.AgentCheckpointed,
        { turn: 2, snapshotRef: "/a/2.tar.gz", remoteRef: "mem://sb-1/2.tar.gz" },
        3,
      ),
    ]);

    expect(await findCheckpoints(adapter, "agent", "sb-1")).toEqual([
      { turn: 2, snapshotRef: "/a/2.tar.gz", remoteRef: "mem://sb-1/2.tar.gz" },
      { turn: 1, snapshotRef: "/a/1.tar.gz" },
    ]);
  });

  it("is empty when the agent was never checkpointed", async () => {
    expect(await findCheckpoints(fakeAdapter([]), "agent", "sb-1")).toEqual([]);
  });
});

describe("fetchCheckpoint (M4, 4.1)", () => {
  function localFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "fetch-test-"));
    const file = join(dir, "c.tar.gz");
    writeFileSync(file, content);
    return file;
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  it("reads the host file first, without touching the store", async () => {
    const store = new MemoryBlobStore();
    store.get = () => Promise.reject(new Error("the store must not be asked"));
    const bytes = await fetchCheckpoint(
      { turn: 1, snapshotRef: localFile("local"), remoteRef: store.refOf("sb-1/1.tar.gz") },
      { blobStore: store },
    );
    expect(text(bytes)).toBe("local");
  });

  it("downloads from the store when the host file is gone (a lost disk)", async () => {
    const store = new MemoryBlobStore();
    await store.put("sb-1/1.tar.gz", new TextEncoder().encode("remote"));

    const bytes = await fetchCheckpoint(
      { turn: 1, snapshotRef: "/gone/1.tar.gz", remoteRef: store.refOf("sb-1/1.tar.gz") },
      { blobStore: store },
    );

    expect(text(bytes)).toBe("remote");
  });

  it("says both places failed when neither has it", async () => {
    const store = new MemoryBlobStore();
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(
      fetchCheckpoint(
        { turn: 4, snapshotRef: "/gone/4.tar.gz", remoteRef: store.refOf("sb-1/4.tar.gz") },
        { blobStore: store },
      ),
    ).rejects.toThrow(
      /turn 4 is not on this host and mem:\/\/sb-1\/4\.tar\.gz could not be fetched/,
    );
  });

  it("explains a checkpoint that never had an off-box copy", async () => {
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(fetchCheckpoint({ turn: 2, snapshotRef: "/gone/2.tar.gz" })).rejects.toThrow(
      /no off-box copy/,
    );
  });

  it("explains a remote reference no store was given for", async () => {
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(
      fetchCheckpoint({ turn: 2, snapshotRef: "/gone/2.tar.gz", remoteRef: "s3://b/k" }),
    ).rejects.toThrow(/no BlobStore that owns it was given/);
  });
});

describe("pickRestorable", () => {
  it("falls back to the next older checkpoint when the newest cannot be read", async () => {
    const store = new MemoryBlobStore();
    await store.put("sb-1/1.tar.gz", new TextEncoder().encode("older"));

    const picked = await pickRestorable(
      [
        { turn: 2, snapshotRef: "/gone/2.tar.gz", remoteRef: store.refOf("sb-1/2.tar.gz") },
        { turn: 1, snapshotRef: "/gone/1.tar.gz", remoteRef: store.refOf("sb-1/1.tar.gz") },
      ],
      { blobStore: store },
    );

    expect(picked?.checkpoint.turn).toBe(1);
    expect(new TextDecoder().decode(picked!.bytes)).toBe("older");
    expect(picked?.skipped.map((s) => s.turn)).toEqual([2]);
  });

  it("returns null when no checkpoint can be read", async () => {
    expect(await pickRestorable([{ turn: 1, snapshotRef: "/gone/1.tar.gz" }])).toBeNull();
  });

  it("returns null for an empty list", async () => {
    expect(await pickRestorable([])).toBeNull();
  });
});

describe("restoreCheckpoint with a store", () => {
  it("extracts the downloaded bytes when the host file is gone", async () => {
    const store = new MemoryBlobStore();
    await store.put("sb-1/1.tar.gz", new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
    const uploaded: Uint8Array[] = [];
    // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial
    const sb = {
      writeFileBytes: async (_p: string, bytes: Uint8Array) => {
        uploaded.push(bytes);
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as SandboxHandle;

    await restoreCheckpoint(sb, "/gone/1.tar.gz", {
      blobStore: store,
      remoteRef: store.refOf("sb-1/1.tar.gz"),
    });

    expect([...uploaded[0]!]).toEqual([0x1f, 0x8b, 0x00, 0xff]);
  });
});
