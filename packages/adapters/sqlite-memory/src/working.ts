import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IPagedWorkingMemoryProvider, ResourceRef } from "@alineo-labs/memory";
import { scopeKey } from "@alineo-labs/memory";
import { WORKING_MEMORY_MIGRATION_SQL } from "./migrations";

type Row = { value: string };

/**
 * Persisted `IWorkingMemoryProvider` backed by `bun:sqlite` — a real, file-based backend with
 * zero external services, same "just a file" story as `@alineo-labs/sqlite`'s ledger adapter.
 * Survives process restarts, unlike `InMemoryWorkingMemoryProvider`.
 */
export class SQLiteWorkingMemoryProvider implements IPagedWorkingMemoryProvider {
  private readonly db: Database;

  constructor(path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    this.db = new Database(path, { create: true });
    this.db.exec(WORKING_MEMORY_MIGRATION_SQL);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  async get(ref: ResourceRef, key: string): Promise<unknown | undefined> {
    const row = this.db
      .prepare<Row, [string, string]>(
        "SELECT value FROM alineo_working_memory WHERE scope = ? AND key = ?",
      )
      .get(scopeKey(ref), key);
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  async set(ref: ResourceRef, key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO alineo_working_memory (scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      )
      .run(scopeKey(ref), key, JSON.stringify(value));
  }

  async list(ref: ResourceRef): Promise<Record<string, unknown>> {
    const rows = this.db
      .prepare<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM alineo_working_memory WHERE scope = ?",
      )
      .all(scopeKey(ref));
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  }

  /**
   * One page, walking the `(scope, key)` primary-key index — cost follows `limit`, not how many
   * keys the resource has. Ascending UTF-8 byte order (SQLite's BINARY collation), which is the
   * order `listPage`'s contract names.
   */
  async listPage(
    ref: ResourceRef,
    opts: { after?: string; limit: number },
  ): Promise<{ entries: Array<[string, unknown]>; more: boolean }> {
    const limit = Math.max(0, Math.floor(opts.limit));
    const scope = scopeKey(ref);
    // One extra row, to learn whether another page exists without a second query.
    const rows =
      opts.after === undefined
        ? this.db
            .prepare<{ key: string; value: string }, [string, number]>(
              "SELECT key, value FROM alineo_working_memory WHERE scope = ? ORDER BY key LIMIT ?",
            )
            .all(scope, limit + 1)
        : this.db
            .prepare<{ key: string; value: string }, [string, string, number]>(
              "SELECT key, value FROM alineo_working_memory WHERE scope = ? AND key > ? ORDER BY key LIMIT ?",
            )
            .all(scope, opts.after, limit + 1);
    const page = rows.slice(0, limit);
    return {
      entries: page.map((r): [string, unknown] => [r.key, JSON.parse(r.value) as unknown]),
      more: rows.length > limit,
    };
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
