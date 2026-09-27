/**
 * One-time rename of the `command` column to the CLI's current verbs.
 *
 * `alineo-cli@0.4.0` renames three session-lifecycle verbs so one word means one thing across
 * the CLI, the SDK and the MCP tools:
 *
 *     alineo spawn <spec>              →  alineo start <spec>
 *     alineo fork <name> <child-spec>  →  alineo spawn <parent> <child-spec>
 *     alineo kill <sandbox-id>         →  alineo stop <sandbox-id>
 *
 * Rows written before that carry the old spelling, so any count over this table splits one
 * action across two names — and `spawn` is worse than split, it is *wrong*: pre-0.4.0 it meant
 * "create a root agent", which is today's `start`, while post-0.4.0 it means "create a child".
 * The same string, two actions, in one column.
 *
 * **Keyed on `cli_version`, not on a date.** Older CLIs do not vanish when a new one ships;
 * an 0.2.1 install will keep sending `spawn`-meaning-root for as long as someone has it. The
 * version is the only thing in the row that says which vocabulary the sender spoke.
 *
 * **One statement, not three.** The renames chain — `spawn` becomes `start` while `fork`
 * becomes `spawn` — so running them in sequence would walk `fork` all the way to `start` if
 * they happened in the wrong order. A single `CASE` evaluates against the original value.
 */
import type { Database } from "bun:sqlite";

/** The first release where `spawn` means "child". See `.changeset/cli-verb-rename.md`. */
export const FIRST_RENAMED_VERSION = "0.4.0";

/** Old spelling → new, as of `alineo-cli@0.4.0`. */
export const RENAMED_COMMANDS: [string, string][] = [
  ["spawn", "start"],
  ["fork", "spawn"],
  ["kill", "stop"],
];

/**
 * `cli_version` is free text off an unauthenticated public endpoint, so "looks like a version"
 * is a real question rather than a formality. Anything that does not is left alone below: an
 * unreadable version means an unknown vocabulary, and renaming on a guess would corrupt the
 * row rather than merely leave it ambiguous.
 */
export function isVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v.trim());
}

/** `-1 | 0 | 1`, comparing only the numeric core so `0.4.0-beta.1` sorts below `0.4.0`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.split("-")[0] ?? "").split(".").map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // A prerelease of the target version is still the old vocabulary: 0.4.0-beta < 0.4.0.
  const pre = (v: string) => (v.includes("-") ? 0 : 1);
  return pre(a) - pre(b);
}

/**
 * Unlike every other migration in this repo, this one records that it ran.
 *
 * The others are idempotent by construction: `WHERE event IN (…old names…)` matches nothing on
 * a second pass, and that *is* the version check. That argument does not survive a chained
 * rename. After this runs, a pre-0.4.0 row reading `spawn` is a migrated `fork` — indis-
 * tinguishable from an unmigrated `spawn`, which a second pass would happily rewrite to
 * `start`. There is no value in the row that separates the two, so the fact has to be written
 * down somewhere.
 */
function alreadyApplied(db: Database, name: string): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  return db.query("SELECT 1 FROM migrations WHERE name = ?").get(name) !== null;
}

export function migrateCommandNames(db: Database): number {
  const NAME = "command-names-0.4.0";
  if (alreadyApplied(db, NAME)) return 0;

  const cases = RENAMED_COMMANDS.map(() => "WHEN command = ? THEN ?").join(" ");
  const olds = RENAMED_COMMANDS.map(([from]) => from);

  // `cli_version` is free text off the wire, so the version test runs here rather than in SQL:
  // a row whose version does not parse is left alone rather than guessed at.
  const stale = db
    .query<{ id: string; cli_version: string }, [...string[]]>(
      `SELECT id, cli_version FROM events WHERE command IN (${olds.map(() => "?").join(", ")})`,
    )
    .all(...olds)
    .filter(
      (row) =>
        isVersion(row.cli_version) && compareVersions(row.cli_version, FIRST_RENAMED_VERSION) < 0,
    )
    .map((row) => row.id);

  const update = db.query(
    `UPDATE events SET command = CASE ${cases} ELSE command END WHERE id = ?`,
  );
  const params = RENAMED_COMMANDS.flat();

  const run = db.transaction(() => {
    for (const id of stale) update.run(...params, id);
    db.run("INSERT INTO migrations (name, applied_at) VALUES (?, ?)", [NAME, Date.now()]);
  });
  run();
  return stale.length;
}
