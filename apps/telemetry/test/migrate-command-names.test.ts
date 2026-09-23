/**
 * The chained rename is the part that can quietly go wrong: `spawn` becomes `start` while
 * `fork` becomes `spawn`, so a sequential pass in the wrong order walks `fork` all the way to
 * `start`, and a second pass over the result does the same thing again.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  compareVersions,
  FIRST_RENAMED_VERSION,
  isVersion,
  migrateCommandNames,
} from "../migrate-command-names";

function eventsDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, command TEXT NOT NULL, flags TEXT NOT NULL, spec_provider TEXT,
    outcome TEXT NOT NULL, error_class TEXT, duration_ms INTEGER NOT NULL,
    cli_version TEXT NOT NULL, os_platform TEXT NOT NULL, os_arch TEXT NOT NULL,
    bun_version TEXT NOT NULL, is_ci INTEGER NOT NULL, anonymous_id TEXT NOT NULL,
    received_at INTEGER NOT NULL
  )`);
  return db;
}

let seq = 0;
function seed(db: Database, command: string, cliVersion: string): string {
  const id = `e${++seq}`;
  db.run(
    `INSERT INTO events VALUES (?, ?, '{}', NULL, 'success', NULL, 1, ?, 'linux', 'x64',
     '1.0.0', 0, 'anon', 1000)`,
    [id, command, cliVersion],
  );
  return id;
}

const commandOf = (db: Database, id: string) =>
  db.query<{ command: string }, [string]>("SELECT command FROM events WHERE id = ?").get(id)
    ?.command;

describe("migrateCommandNames", () => {
  test("renames the three verbs on rows from a pre-0.4.0 CLI", () => {
    const db = eventsDb();
    const spawn = seed(db, "spawn", "0.2.1");
    const fork = seed(db, "fork", "0.2.1");
    const kill = seed(db, "kill", "0.1.5");

    expect(migrateCommandNames(db)).toBe(3);
    expect(commandOf(db, spawn)).toBe("start");
    expect(commandOf(db, fork)).toBe("spawn");
    expect(commandOf(db, kill)).toBe("stop");
  });

  test("does not walk fork through spawn and on to start", () => {
    // The whole reason this is one CASE and not three UPDATEs.
    const db = eventsDb();
    const fork = seed(db, "fork", "0.2.1");
    migrateCommandNames(db);
    expect(commandOf(db, fork)).toBe("spawn");
  });

  test("is a no-op the second time, even though the result looks unmigrated", () => {
    // After the first pass a pre-0.4.0 row reading `spawn` is a migrated `fork`, which no
    // amount of looking at the row can distinguish from an unmigrated `spawn`. This is why
    // this migration writes down that it ran and the others do not have to.
    const db = eventsDb();
    const fork = seed(db, "fork", "0.2.1");
    expect(migrateCommandNames(db)).toBe(1);
    expect(migrateCommandNames(db)).toBe(0);
    expect(commandOf(db, fork)).toBe("spawn");
  });

  test("leaves a post-0.4.0 spawn alone — there it already means 'child'", () => {
    const db = eventsDb();
    const child = seed(db, "spawn", FIRST_RENAMED_VERSION);
    const newer = seed(db, "spawn", "1.2.0");
    expect(migrateCommandNames(db)).toBe(0);
    expect(commandOf(db, child)).toBe("spawn");
    expect(commandOf(db, newer)).toBe("spawn");
  });

  test("migrates an old CLI's spawn even after the new one has shipped", () => {
    // An 0.2.1 install does not vanish when 0.4.0 lands; both keep sending `spawn`, meaning
    // opposite things. This is why the cut is the version and not a date.
    const db = eventsDb();
    const old = seed(db, "spawn", "0.2.1");
    const current = seed(db, "spawn", "0.4.1");
    expect(migrateCommandNames(db)).toBe(1);
    expect(commandOf(db, old)).toBe("start");
    expect(commandOf(db, current)).toBe("spawn");
  });

  test("leaves commands that were never renamed alone", () => {
    const db = eventsDb();
    const init = seed(db, "init", "0.2.1");
    const skills = seed(db, "skills", "0.2.1"); // retired with no successor
    migrateCommandNames(db);
    expect(commandOf(db, init)).toBe("init");
    expect(commandOf(db, skills)).toBe("skills");
  });

  test("leaves a row whose version does not parse alone rather than guessing", () => {
    const db = eventsDb();
    const junk = seed(db, "spawn", "not-a-version");
    migrateCommandNames(db);
    expect(commandOf(db, junk)).toBe("spawn");
  });

  test("isVersion rejects what is not a version", () => {
    for (const ok of ["0.2.1", "1.0.0", "0.4.0-beta.1", "10.20.30"])
      expect(isVersion(ok)).toBe(true);
    for (const bad of ["not-a-version", "", "0.4", "v0.4.0", "latest"])
      expect(isVersion(bad)).toBe(false);
  });

  test("compareVersions sorts a prerelease below its release", () => {
    expect(compareVersions("0.2.1", "0.4.0")).toBe(-1);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.4.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.4.0")).toBe(1);
    expect(compareVersions("0.4.0-beta.1", "0.4.0")).toBe(-1);
  });
});
