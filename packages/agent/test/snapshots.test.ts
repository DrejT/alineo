import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSnapshotStore } from "../src/snapshots";

function store(): AgentSnapshotStore {
  return new AgentSnapshotStore(join(mkdtempSync(join(tmpdir(), "snapshots-test-")), "s.json"));
}

const record = (specName: string, setupHash = "h1") => ({
  specName,
  setupHash,
  snapshotId: `snap-${specName}-${setupHash}`,
  createdAt: 1,
});

describe("AgentSnapshotStore", () => {
  it("keeps every record when several specs save at the same time", async () => {
    const s = store();
    const names = Array.from({ length: 12 }, (_, i) => `spec-${i}`);

    await Promise.all(names.map((n) => s.save(record(n))));

    expect((await s.list()).map((r) => r.specName).sort()).toEqual([...names].sort());
  });

  it("a save and a delete racing do not lose the save", async () => {
    const s = store();
    await s.save(record("old"));

    await Promise.all([s.delete("old"), s.save(record("new"))]);

    expect((await s.list()).map((r) => r.specName)).toEqual(["new"]);
  });

  it("replaces an older record for the same spec", async () => {
    const s = store();
    await s.save(record("a", "h1"));
    await s.save(record("a", "h2"));

    expect((await s.list()).map((r) => r.setupHash)).toEqual(["h2"]);
  });

  it("keeps working after a write fails", async () => {
    const s = new AgentSnapshotStore("/proc/definitely/not/writable/s.json");
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(s.save(record("a"))).rejects.toThrow();

    // The chain must not stay rejected: the next call still runs (and fails on its own merits).
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(s.save(record("b"))).rejects.toThrow();
    expect(await s.get("a", "h1")).toBeNull();
  });
});
