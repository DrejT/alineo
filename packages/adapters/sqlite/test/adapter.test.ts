import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerEvent, SandboxStatus, type LedgerEntry } from "@alineo-labs/core";
import { SQLiteAdapter } from "../src/adapter.ts";

function entry(overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: Date.now(),
    name: "test-session",
    sandboxId: "session-1",
    stepIndex: 0,
    event: LedgerEvent.ExecStart,
    ...overrides,
  };
}

describe("SQLiteAdapter", () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(":memory:");
    await db.connect();
  });

  afterEach(async () => {
    await db.close();
  });

  // ── append / readAll ────────────────────────────────────────────────────────

  describe("append / readAll", () => {
    it("stores and retrieves an entry", async () => {
      await db.append(entry({ event: LedgerEvent.ExecStart }));
      const rows = await db.readAll("test-session", "session-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe(LedgerEvent.ExecStart);
    });

    it("returns entries in ascending timestamp order", async () => {
      await db.append(entry({ ts: 2000, event: LedgerEvent.ExecComplete }));
      await db.append(entry({ ts: 1000, event: LedgerEvent.ExecStart }));
      const rows = await db.readAll("test-session", "session-1");
      expect(rows[0].ts).toBe(1000);
      expect(rows[1].ts).toBe(2000);
    });

    it("scopes to the given name and sandboxId", async () => {
      await db.append(entry({ name: "session-a", sandboxId: "s1" }));
      await db.append(entry({ name: "session-b", sandboxId: "s2" }));
      expect(await db.readAll("session-a", "s1")).toHaveLength(1);
      expect(await db.readAll("session-b", "s2")).toHaveLength(1);
      expect(await db.readAll("session-a", "s2")).toHaveLength(0);
    });

    it("serialises and deserialises JSON payload", async () => {
      await db.append(entry({ payload: { key: "value", n: 42 } }));
      const rows = await db.readAll("test-session", "session-1");
      expect(rows[0].payload).toEqual({ key: "value", n: 42 });
    });

    it("preserves null payload as undefined", async () => {
      await db.append(entry({ payload: undefined }));
      const rows = await db.readAll("test-session", "session-1");
      expect(rows[0].payload).toBeUndefined();
    });

    it("preserves the branch field", async () => {
      await db.append(entry({ branch: 2 }));
      const rows = await db.readAll("test-session", "session-1");
      expect(rows[0].branch).toBe(2);
    });

    it("returns undefined branch when not set", async () => {
      await db.append(entry());
      const rows = await db.readAll("test-session", "session-1");
      expect(rows[0].branch).toBeUndefined();
    });
  });

  // ── lastCheckpoint ──────────────────────────────────────────────────────────

  describe("lastCheckpoint", () => {
    it("returns null when no checkpoint exists", async () => {
      expect(await db.lastCheckpoint("test-session", "session-1")).toBeNull();
    });

    it("returns the most recent checkpoint_created event", async () => {
      await db.append(
        entry({
          ts: 1000,
          event: LedgerEvent.CheckpointCreated,
          payload: { snapshotId: "snap-1" },
        }),
      );
      await db.append(
        entry({
          ts: 2000,
          event: LedgerEvent.CheckpointCreated,
          payload: { snapshotId: "snap-2" },
        }),
      );
      const cp = await db.lastCheckpoint("test-session", "session-1");
      if (!cp) throw new Error("expected a checkpoint");
      expect((cp.payload as { snapshotId: string }).snapshotId).toBe("snap-2");
    });

    it("ignores non-checkpoint events", async () => {
      await db.append(entry({ event: LedgerEvent.ExecStart }));
      expect(await db.lastCheckpoint("test-session", "session-1")).toBeNull();
    });
  });

  // ── session details ─────────────────────────────────────────────────────────

  async function seedSession(
    name: string,
    sandboxId: string,
    opts: { close?: boolean; execCount?: number } = {},
  ) {
    const ts = Date.now();
    await db.append(
      entry({ name, sandboxId, ts, stepIndex: -1, event: LedgerEvent.SandboxCreated }),
    );
    for (let i = 0; i < (opts.execCount ?? 1); i++) {
      await db.append(
        entry({ name, sandboxId, ts: ts + i + 1, stepIndex: i, event: LedgerEvent.ExecComplete }),
      );
    }
    if (opts.close) {
      await db.append(
        entry({ name, sandboxId, ts: ts + 100, stepIndex: -1, event: LedgerEvent.SandboxClosed }),
      );
    }
  }

  describe("getSandboxDetails", () => {
    it("returns null for an unknown session", async () => {
      expect(await db.getSandboxDetails("x", "no-such-session")).toBeNull();
    });

    it("returns Completed status when sandbox_closed present", async () => {
      await seedSession("sb", "s1", { close: true, execCount: 2 });
      const d = await db.getSandboxDetails("sb", "s1");
      expect(d?.status).toBe(SandboxStatus.Completed);
      expect(d?.execCount).toBe(2);
    });

    it("returns Running when no sandbox_closed event", async () => {
      await seedSession("sb", "s1", { close: false });
      const d = await db.getSandboxDetails("sb", "s1");
      expect(d?.status).toBe(SandboxStatus.Running);
    });

    it("exposes sandboxId and name", async () => {
      await seedSession("my-sb", "abc-123", { close: true });
      const d = await db.getSandboxDetails("my-sb", "abc-123");
      expect(d?.sandboxId).toBe("abc-123");
      expect(d?.name).toBe("my-sb");
      expect(d?.runId).toBe("abc-123");
      expect((d as unknown as { workflowName?: unknown } | null)?.workflowName).toBeUndefined();
    });
  });

  describe("listSandboxDetails", () => {
    it("scopes to a single name", async () => {
      await seedSession("sb-a", "s1", { close: true });
      await seedSession("sb-b", "s2", { close: true });
      const results = await db.listSandboxDetails("sb-a");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("sb-a");
    });

    it("filters by status", async () => {
      await seedSession("sb", "s1", { close: true });
      await seedSession("sb", "s2", { close: false });
      const completed = await db.listSandboxDetails("sb", { status: SandboxStatus.Completed });
      expect(completed).toHaveLength(1);
      expect(completed[0].sandboxId).toBe("s1");
    });

    it("respects the limit option", async () => {
      await seedSession("sb", "s1", { close: true });
      await seedSession("sb", "s2", { close: true });
      expect(await db.listSandboxDetails("sb", { limit: 1 })).toHaveLength(1);
    });
  });

  describe("listAllSandboxDetails", () => {
    it("returns sessions across all names", async () => {
      await seedSession("sb-a", "s1", { close: true });
      await seedSession("sb-b", "s2", { close: true });
      expect(await db.listAllSandboxDetails()).toHaveLength(2);
    });

    it("filters by status across names", async () => {
      await seedSession("sb-a", "s1", { close: true });
      await seedSession("sb-b", "s2", { close: false });
      const running = await db.listAllSandboxDetails({ status: SandboxStatus.Running });
      expect(running).toHaveLength(1);
      expect(running[0].name).toBe("sb-b");
    });
  });

  describe("deleteSandbox", () => {
    it("removes all entries for the session", async () => {
      await seedSession("sb", "s1", { close: true });
      await db.deleteSandbox("sb", "s1");
      expect(await db.readAll("sb", "s1")).toHaveLength(0);
      expect(await db.getSandboxDetails("sb", "s1")).toBeNull();
    });

    it("does not affect other sessions", async () => {
      await seedSession("sb", "s1", { close: true });
      await seedSession("sb", "s2", { close: true });
      await db.deleteSandbox("sb", "s1");
      expect(await db.getSandboxDetails("sb", "s2")).not.toBeNull();
    });
  });

  // ── environments ────────────────────────────────────────────────────────────

  describe("environments", () => {
    it("getEnvironment returns null for unknown name", async () => {
      expect(await db.getEnvironment("no-such")).toBeNull();
    });

    it("saveEnvironment + getEnvironment round-trips all fields", async () => {
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-1",
        image: "debian:slim",
        builtAt: 1000,
      });
      const r = await db.getEnvironment("py");
      expect(r).toEqual({ name: "py", snapshotId: "snap-1", image: "debian:slim", builtAt: 1000 });
    });

    it("saveEnvironment upserts: second write updates the record", async () => {
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-1",
        image: "debian:slim",
        builtAt: 1000,
      });
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-2",
        image: "debian:slim",
        builtAt: 2000,
      });
      const r = await db.getEnvironment("py");
      expect(r?.snapshotId).toBe("snap-2");
      expect(r?.builtAt).toBe(2000);
    });

    it("deleteEnvironment removes the record", async () => {
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-1",
        image: "debian:slim",
        builtAt: 1000,
      });
      await db.deleteEnvironment("py");
      expect(await db.getEnvironment("py")).toBeNull();
    });

    it("deleteEnvironment is a no-op for unknown name", async () => {
      // bun-types types `.resolves`/`.rejects` as Matchers<unknown>, whose assertion methods
      // return void — the actual async runtime behavior isn't reflected in the type.
      // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression
      await expect(db.deleteEnvironment("no-such")).resolves.toBeUndefined();
    });

    it("listEnvironments returns all records newest-first", async () => {
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-1",
        image: "debian:slim",
        builtAt: 1000,
      });
      await db.saveEnvironment({
        name: "node",
        snapshotId: "snap-2",
        image: "node:22",
        builtAt: 2000,
      });
      const list = await db.listEnvironments();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe("node");
      expect(list[1].name).toBe("py");
    });

    it("listEnvironments returns empty array when no environments exist", async () => {
      expect(await db.listEnvironments()).toEqual([]);
    });

    it("deleteEnvironment does not affect other records", async () => {
      await db.saveEnvironment({
        name: "py",
        snapshotId: "snap-1",
        image: "debian:slim",
        builtAt: 1000,
      });
      await db.saveEnvironment({
        name: "node",
        snapshotId: "snap-2",
        image: "node:22",
        builtAt: 2000,
      });
      await db.deleteEnvironment("py");
      expect(await db.getEnvironment("node")).not.toBeNull();
    });
  });

  describe("constructor", () => {
    it("creates missing parent directories instead of throwing SQLITE_CANTOPEN", async () => {
      const root = join(tmpdir(), `alineo-sqlite-test-${Date.now()}`);
      const dir = join(root, "nested", "path");
      const dbPath = join(dir, "ledger.db");
      expect(existsSync(dir)).toBe(false);

      const nested = new SQLiteAdapter(dbPath);
      try {
        await nested.connect();
        await nested.append(entry());
        expect(await nested.readAll("test-session", "session-1")).toHaveLength(1);
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        await nested.close();
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (e) {
          // Don't throw from a finally block — that would silently replace any real
          // assertion failure from the try block above with this cleanup error instead.
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "EBUSY" && code !== "EPERM") {
            console.error("temp dir cleanup failed:", e);
          }
        }
      }
    });
  });
});
