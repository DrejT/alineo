import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IWorkingMemoryProvider, ResourceRef } from "@alineo-labs/memory";
import { scopeKey } from "@alineo-labs/memory";
import { WORKING_MEMORY_MIGRATION_SQL } from "./migrations";

type Row = { value: string };

/**
 * Persisted `IWorkingMemoryProvider` backed by `bun:sqlite` — a real, file-based backend with
 * zero external services, same "just a file" story as `@alineo-labs/sqlite`'s ledger adapter.
 * Survives process restarts, unlike `InMemoryWorkingMemoryProvider`.
 */
export class SQLiteWorkingMemoryProvider<V = unknown> implements IWorkingMemoryProvider<V> {
  private readonly db: Database;

  constructor(path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e) {
      // SAFETY: mkdirSync only ever throws Node fs errors, which are always
      // ErrnoException-shaped (optional `.code`).
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
    }

    this.db = new Database(path, { create: true });
    this.db.exec(WORKING_MEMORY_MIGRATION_SQL);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  async get(ref: ResourceRef, key: string): Promise<V | undefined> {
    const row = this.db
      .prepare<Row, [string, string]>(
        "SELECT value FROM alineo_working_memory WHERE scope = ? AND key = ?",
      )
      .get(scopeKey(ref), key);

    // SAFETY: values are only ever written by this class's own `set()`, which
    // JSON.stringifies a `V`, so parsing a stored row back yields a `V`.
    return row ? (JSON.parse(row.value) as V) : undefined;
  }

  async set(ref: ResourceRef, key: string, value: V): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO alineo_working_memory (scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      )
      .run(scopeKey(ref), key, JSON.stringify(value));
  }

  async list(ref: ResourceRef): Promise<Record<string, V>> {
    const rows = this.db
      .prepare<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM alineo_working_memory WHERE scope = ?",
      )
      .all(scopeKey(ref));

    // SAFETY: same set()-writes-this-class's-own-rows invariant as get() above.
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as V]));
  }

  async delete(ref: ResourceRef, key: string): Promise<void> {
    this.db
      .prepare("DELETE FROM alineo_working_memory WHERE scope = ? AND key = ?")
      .run(scopeKey(ref), key);
  }

  /** Release the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}
