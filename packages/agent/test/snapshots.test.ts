import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSnapshotStore } from "../src/snapshots";

describe("AgentSnapshotStore provider scoping", () => {
  let dir: string;
  let path: string;
  let store: AgentSnapshotStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alineo-snapshots-"));
    path = join(dir, "agent-snapshots.json");
    store = new AgentSnapshotStore(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the legacy key for OpenSandbox, so an existing file keeps working", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        "root:c6ceedf9adda": {
          specName: "root",
          setupHash: "c6ceedf9adda",
          snapshotId: "snap-old",
          createdAt: 1,
        },
      }),
    );

    const record = await store.get("root", "c6ceedf9adda");
    expect(record?.snapshotId).toBe("snap-old");
  });

  it("saves an OpenSandbox record under the legacy key", async () => {
    await store.save({ specName: "root", setupHash: "h1", snapshotId: "s1", createdAt: 1 });
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(["root:h1"]);
  });

  it("does not return one provider's snapshot to another", async () => {
    await store.save({
      specName: "root",
      setupHash: "h1",
      provider: "opensandbox",
      snapshotId: "os-snap",
      createdAt: 1,
    });

    expect(await store.get("root", "h1", "e2b")).toBeNull();
    expect((await store.get("root", "h1", "opensandbox"))?.snapshotId).toBe("os-snap");
  });

  it("saving for one provider does not delete another provider's record of the same spec", async () => {
    await store.save({
      specName: "root",
      setupHash: "h1",
      provider: "opensandbox",
      snapshotId: "os-snap",
      createdAt: 1,
    });
    await store.save({
      specName: "root",
      setupHash: "h1",
      provider: "e2b",
      snapshotId: "e2b-snap",
      createdAt: 2,
    });

    expect((await store.get("root", "h1", "opensandbox"))?.snapshotId).toBe("os-snap");
    expect((await store.get("root", "h1", "e2b"))?.snapshotId).toBe("e2b-snap");
  });

  it("still replaces a stale record of the same spec and provider", async () => {
    await store.save({ specName: "root", setupHash: "h1", snapshotId: "old", createdAt: 1 });
    await store.save({ specName: "root", setupHash: "h2", snapshotId: "new", createdAt: 2 });

    expect(await store.get("root", "h1")).toBeNull();
    expect((await store.get("root", "h2"))?.snapshotId).toBe("new");
  });
});

function concurrentStore(): AgentSnapshotStore {
  return new AgentSnapshotStore(join(mkdtempSync(join(tmpdir(), "snapshots-test-")), "s.json"));
}

const record = (specName: string, setupHash = "h1") => ({
  specName,
  setupHash,
  snapshotId: `snap-${specName}-${setupHash}`,
  createdAt: 1,
});

describe("AgentSnapshotStore concurrent writes", () => {
  it("keeps every record when several specs save at the same time", async () => {
    const s = concurrentStore();
    const names = Array.from({ length: 12 }, (_, i) => `spec-${i}`);

    await Promise.all(names.map((n) => s.save(record(n))));

    expect((await s.list()).map((r) => r.specName).sort()).toEqual([...names].sort());
  });

  it("a save and a delete racing do not lose the save", async () => {
    const s = concurrentStore();
    await s.save(record("old"));

    await Promise.all([s.delete("old"), s.save(record("new"))]);

    expect((await s.list()).map((r) => r.specName)).toEqual(["new"]);
  });

  it("replaces an older record for the same spec", async () => {
    const s = concurrentStore();
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
