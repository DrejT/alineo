import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngineLedgerEntry, EngineLedgerRow, IEngineLedger } from "@alineo-labs/core";

export const ENGINE_LEDGER_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS engine_ledger (
  seq       INTEGER PRIMARY KEY,
  scope     TEXT    NOT NULL,
  sub_scope TEXT,
  ts        INTEGER NOT NULL,
  event     TEXT    NOT NULL,
  payload   TEXT
);
CREATE INDEX IF NOT EXISTS engine_ledger_scope ON engine_ledger (scope, seq);
CREATE INDEX IF NOT EXISTS engine_ledger_sub_scope_event ON engine_ledger (sub_scope, event, seq);
`;

/**
 * Column names to bind this ledger onto. Defaults to its own `engine_ledger` table — but a
 * consumer with a pre-existing, differently-named ledger table (alineod's `ledger`, with
 * `run_id`/`agent_id` instead of `scope`/`sub_scope`) can point this at its *own* table and
 * columns instead, so the physical schema never has to change. `seq`/`ts`/`event`/`payload`
 * are not configurable — every known consumer's schema already spells them the same way.
 */
export interface SQLiteEngineLedgerSchema {
  table: string;
  scopeColumn: string;
  subScopeColumn: string;
}

const DEFAULT_SCHEMA: SQLiteEngineLedgerSchema = {
  table: "engine_ledger",
  scopeColumn: "scope",
  subScopeColumn: "sub_scope",
};

type Row = {
  seq: number;
  scope: string;
  sub_scope: string | null;
  ts: number;
  event: string;
  payload: string | null;
};

function rowToEntry(row: Row): EngineLedgerRow {
  return {
    seq: row.seq,
    scope: row.scope,
    subScope: row.sub_scope ?? undefined,
    ts: row.ts,
    event: row.event,
    payload: row.payload !== null ? (JSON.parse(row.payload) as unknown) : undefined,
  };
}

/**
 * A row with `payload` left as the raw stored string, never `JSON.parse`d. Exists because
 * `rowToEntry`'s eager parse turns one historically-malformed row (bad JSON written before a
 * validation bug was fixed, or written directly for a test) into a hard failure for every
 * other row in the same read — the caller never gets a chance to catch and skip just that one.
 * alineod's `db.ts` depends on exactly this: a damaged `ledger` row must not break reading the
 * rest of a run's events (`apps/alineod/test/transcript.test.ts`'s "skips a damaged row").
 */
export interface RawEngineLedgerRow {
  seq: number;
  scope: string;
  subScope: string | null;
  ts: number;
  event: string;
  payload: string | null;
}

function rowToRawEntry(row: Row): RawEngineLedgerRow {
  return {
    seq: row.seq,
    scope: row.scope,
    subScope: row.sub_scope,
    ts: row.ts,
    event: row.event,
    payload: row.payload,
  };
}

/**
 * `IEngineLedger` on `bun:sqlite` — durability-roadmap.md M3 (3.1b). alineod's own
 * `apps/alineod/src/state/db.ts` is this interface's first non-sandbox-SDK consumer: it binds
 * this onto its *existing* `ledger` table (`run_id`/`agent_id`, via `schema`) rather than
 * migrating onto a renamed one, since 11 other files across `apps/alineod` (migrations, ops
 * checks, several tests) already address that table and its columns directly in raw SQL —
 * renaming it would ripple into all of them for no behavioral gain. What alineod actually
 * gets from adopting this: the same query/index shape as the sandbox SDK's own ledger, from
 * one shared, tested implementation, instead of two independently hand-rolled ones that can
 * silently drift (e.g. the composite-index fix in `adapter.ts` otherwise has no reason to ever
 * get applied to alineod's copy).
 */
export class SQLiteEngineLedger implements IEngineLedger {
  private readonly db: Database;
  private readonly ownsConnection: boolean;
  private readonly insert;
  private readonly selectByScope;
  private readonly selectByScopeAfter;
  private readonly selectBySubScope;
  private readonly selectBySubScopeAndEvent;
  private readonly selectAll;

  /**
   * `pathOrDb` accepts either a file path (opens its own connection — a standalone consumer
   * like `apps/sandbox/server/registry.ts`) or an already-open `Database` (a consumer that,
   * like alineod, already manages one shared connection across several tables and must not
   * open a second one to the same file). Pragmas only run for a path, not a passed-in
   * connection — the caller already owns those for their connection.
   *
   * `schema` lets a consumer with a pre-existing, differently-shaped ledger table bind onto
   * its own table/columns instead of this class's default `engine_ledger` one — see
   * `SQLiteEngineLedgerSchema`. When a custom `schema` is given, this class never runs
   * `ENGINE_LEDGER_MIGRATION_SQL`: the caller already owns that table's DDL (its indexes,
   * its migrations), and creating/indexing it here too would duplicate or conflict with that.
   */
  constructor(pathOrDb: string | Database, schema: SQLiteEngineLedgerSchema = DEFAULT_SCHEMA) {
    this.ownsConnection = typeof pathOrDb === "string";
    if (typeof pathOrDb === "string") {
      // Same reasoning as SQLiteAdapter's constructor: create missing parent directories up
      // front, since bun:sqlite only creates the db *file*, not its directory.
      try {
        mkdirSync(dirname(pathOrDb), { recursive: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      this.db = new Database(pathOrDb, { create: true });
      this.db.run("PRAGMA journal_mode = WAL;");
      // Pinned, not inherited — this ledger is the same kind of commit point db.ts's own
      // ledger was: a row is only "committed" if it survives a power loss, and NORMAL under
      // WAL can drop the last commits.
      this.db.run("PRAGMA synchronous = FULL;");
    } else {
      this.db = pathOrDb;
    }
    const isDefaultSchema = schema === DEFAULT_SCHEMA;
    if (isDefaultSchema) this.db.run(ENGINE_LEDGER_MIGRATION_SQL);

    const { table, scopeColumn: sc, subScopeColumn: ssc } = schema;
    const cols = `seq, ${sc} AS scope, ${ssc} AS sub_scope, ts, event, payload`;

    this.insert = this.db.query<
      { seq: number },
      [string, string | null, number, string, string | null]
    >(
      `INSERT INTO ${table} (${sc}, ${ssc}, ts, event, payload)
       VALUES (?, ?, ?, ?, ?) RETURNING seq`,
    );
    this.selectByScope = this.db.query<Row, [string]>(
      `SELECT ${cols} FROM ${table} WHERE ${sc} = ? ORDER BY seq ASC`,
    );
    this.selectByScopeAfter = this.db.query<Row, [string, number]>(
      `SELECT ${cols} FROM ${table} WHERE ${sc} = ? AND seq > ? ORDER BY seq ASC`,
    );
    this.selectBySubScope = this.db.query<Row, [string]>(
      `SELECT ${cols} FROM ${table} WHERE ${ssc} = ? ORDER BY seq ASC`,
    );
    this.selectBySubScopeAndEvent = this.db.query<Row, [string, string]>(
      `SELECT ${cols} FROM ${table} WHERE ${ssc} = ? AND event = ? ORDER BY seq ASC`,
    );
    this.selectAll = this.db.query<Row, []>(`SELECT ${cols} FROM ${table} ORDER BY seq ASC`);
  }

  // No-ops: migrations and pragmas already ran in the constructor, matching db.ts's own
  // module-level-setup convention (its `ledger` table is ready the moment the module is
  // imported, not after a separate connect() call) rather than IStorageAdapter's
  // connect-then-use convention.
  async connect(): Promise<void> {}
  /** A no-op when constructed from a shared connection — the owner closes it, not this. */
  close(): Promise<void> {
    if (this.ownsConnection) this.db.close();
    return Promise.resolve();
  }

  // ── IEngineLedger (async) — thin wrappers over the sync methods below. bun:sqlite's own
  // calls are synchronous; the interface is async only because a future Postgres-backed
  // IEngineLedger genuinely needs to be. Not `async` (no `await` in the body, which the
  // function actually is synchronous) — just wraps the sync result in a resolved Promise. ────
  append(entry: EngineLedgerEntry): Promise<EngineLedgerRow> {
    return Promise.resolve(this.appendSync(entry));
  }
  readByScope(scope: string, opts?: { afterSeq?: number }): Promise<EngineLedgerRow[]> {
    return Promise.resolve(this.readByScopeSync(scope, opts));
  }
  readBySubScope(subScope: string, event?: string): Promise<EngineLedgerRow[]> {
    return Promise.resolve(this.readBySubScopeSync(subScope, event));
  }
  readAll(): Promise<EngineLedgerRow[]> {
    return Promise.resolve(this.readAllSync());
  }

  // ── Synchronous equivalents — for a consumer that, like alineod, is on bun:sqlite and
  // relies on genuinely synchronous reads/writes (its single ledger-write path and
  // boot-time replay are not async today, and this chunk does not make them so). Not part
  // of `IEngineLedger` — SQLite-specific, used only by a caller that already knows its
  // backend and chose this class directly rather than going through the generic interface. ──
  appendSync(entry: EngineLedgerEntry): EngineLedgerRow {
    const payloadJson = entry.payload === undefined ? null : JSON.stringify(entry.payload);
    const { seq } = this.insert.get(
      entry.scope,
      entry.subScope ?? null,
      entry.ts,
      entry.event,
      payloadJson,
    )!;
    return { ...entry, seq };
  }

  readByScopeSync(scope: string, opts?: { afterSeq?: number }): EngineLedgerRow[] {
    const rows =
      opts?.afterSeq !== undefined
        ? this.selectByScopeAfter.all(scope, opts.afterSeq)
        : this.selectByScope.all(scope);
    return rows.map(rowToEntry);
  }

  readBySubScopeSync(subScope: string, event?: string): EngineLedgerRow[] {
    const rows =
      event !== undefined
        ? this.selectBySubScopeAndEvent.all(subScope, event)
        : this.selectBySubScope.all(subScope);
    return rows.map(rowToEntry);
  }

  readAllSync(): EngineLedgerRow[] {
    return this.selectAll.all().map(rowToEntry);
  }

  // ── Raw synchronous equivalents — payload left as the raw stored string. See
  // `RawEngineLedgerRow`'s doc comment for why this exists. ──────────────────────────────────
  readByScopeRawSync(scope: string, opts?: { afterSeq?: number }): RawEngineLedgerRow[] {
    const rows =
      opts?.afterSeq !== undefined
        ? this.selectByScopeAfter.all(scope, opts.afterSeq)
        : this.selectByScope.all(scope);
    return rows.map(rowToRawEntry);
  }

  readBySubScopeRawSync(subScope: string, event?: string): RawEngineLedgerRow[] {
    const rows =
      event !== undefined
        ? this.selectBySubScopeAndEvent.all(subScope, event)
        : this.selectBySubScope.all(subScope);
    return rows.map(rowToRawEntry);
  }

  readAllRawSync(): RawEngineLedgerRow[] {
    return this.selectAll.all().map(rowToRawEntry);
  }
}
