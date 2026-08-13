/**
 * Storage for `alineo` CLI telemetry events -- deliberately plain `bun:sqlite`, not
 * `@alineo-labs/sqlite`'s `IStorageAdapter`: that adapter's schema is shaped around the sandbox
 * ledger (sandboxes/exec events/checkpoints), the wrong model for a flat analytics-events table.
 * Mirrors how `apps/dashboard/server`'s own `workflows-db.ts`/`vault.ts` each spin up their own
 * separate SQLite file/schema rather than forcing an unrelated concept into `IStorageAdapter`'s
 * shape.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config";

/** Intentionally duplicated from `packages/cli/src/telemetry.ts`'s identical interface rather
 * than shared via a workspace package -- this app and `alineo` communicate purely over the
 * `POST /v1/events` HTTP contract, with no runtime/deploy dependency in either direction. Type
 * duplication across an HTTP boundary is the normal cost of that, not a code smell. */
export interface CliTelemetryEvent {
  command: string;
  flags: Record<string, boolean>;
  specProvider?: string;
  outcome: "success" | "error";
  errorClass?: string;
  durationMs: number;
  cliVersion: string;
  osPlatform: string;
  osArch: string;
  bunVersion: string;
  isCI: boolean;
  anonymousId: string;
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id            TEXT    PRIMARY KEY,
  command       TEXT    NOT NULL,
  flags         TEXT    NOT NULL,
  spec_provider TEXT,
  outcome       TEXT    NOT NULL,
  error_class   TEXT,
  duration_ms   INTEGER NOT NULL,
  cli_version   TEXT    NOT NULL,
  os_platform   TEXT    NOT NULL,
  os_arch       TEXT    NOT NULL,
  bun_version   TEXT    NOT NULL,
  is_ci         INTEGER NOT NULL,
  anonymous_id  TEXT    NOT NULL,
  received_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_received_at ON events (received_at);
CREATE INDEX IF NOT EXISTS idx_events_anonymous_id ON events (anonymous_id);
`);

export function insertEvent(event: CliTelemetryEvent): void {
  db.run(
    `INSERT INTO events (
      id, command, flags, spec_provider, outcome, error_class, duration_ms, cli_version,
      os_platform, os_arch, bun_version, is_ci, anonymous_id, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      event.command,
      JSON.stringify(event.flags),
      event.specProvider ?? null,
      event.outcome,
      event.errorClass ?? null,
      event.durationMs,
      event.cliVersion,
      event.osPlatform,
      event.osArch,
      event.bunVersion,
      event.isCI ? 1 : 0,
      event.anonymousId,
      Date.now(),
    ],
  );
}
