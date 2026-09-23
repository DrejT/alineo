/**
 * One-time rename of the spec fields inside the stored `AgentSpec` that `agent.spawned`
 * carries.
 *
 * `migrate-event-names.ts` renames what an event is *called*; this renames what one of them
 * *contains*. Every `agent.spawned` payload keeps the spec its agent was spawned with, as a
 * JSON-encoded string under `specJson`, and `rehydrate()` folds that back into the `agents`
 * projection and hands it to `Alineo.reattach()` / `.resume()`. A spec written before the
 * field rename still says `cli`, which `validateAgentSpec` rejects — so the first boot after
 * an upgrade fails every reattach and marks each still-running agent `lost`.
 *
 * Found by booting this daemon against a copy of a real pre-rename database. The events
 * migrated cleanly and the run still looked intact right up to the point every agent in it
 * was declared dead:
 *
 *     reattach failed — falling back to resume … Agent spec must have a 'harness' field
 *     agent.ended … "outcome":"lost"
 *
 * **The ledger, not the projection.** The first version of this rewrote `agents.spec_json`,
 * which is the copy `rehydrate()` actually reads — and it was silently undone a few
 * milliseconds later, because `rehydrate()` begins with `rebuild()`, which drops both
 * projections and refolds them from the ledger. `agents` is a pure function of these rows;
 * the rows are the only thing worth migrating.
 *
 * **In JavaScript, not in SQL**, unlike every other migration here. The rewrite is "parse a
 * JSON string, rename one key, re-encode", and `specJson` has to go back as a *string* — it
 * is JSON-encoded inside the payload, not a nested object. SQL can express that, but only by
 * relying on which functions carry SQLite's JSON subtype: `json_set(payload, '$.specJson',
 * json_set(…))` silently stores an object instead of a string, and the documented way to
 * strip a subtype — `CAST(… AS TEXT)` — does not strip it on SQLite 3.51 (`'' || x` and
 * `substr(x, 1)` still do). A migration whose correctness turns on that, and whose failure
 * mode is every in-flight agent dying on upgrade, is not worth the one-statement elegance.
 * The read is one scan; the writes are by primary key.
 *
 * **Idempotent by construction**, like every other migration here: a spec with no stale field
 * is skipped, so a second run writes nothing. There is no `schema_version` table in this repo
 * to get out of step with.
 *
 * **This is one-way**, like the event names: an older alineod would meet `harness` and reject
 * the spec it wrote itself.
 */
import type { Database } from "bun:sqlite";

/**
 * The spec fields that changed, old to new. Mirrors `RENAMED_FIELDS` in
 * `packages/agent/src/schema.ts` — the list the validator's error message reads from, which
 * is what a person sees when this migration has *not* run.
 */
const RENAMED_SPEC_FIELDS: [string, string][] = [
  ["cli", "harness"],
  ["cliVersion", "harnessVersion"],
];

/** The rewritten spec, or `undefined` if nothing in it is stale. */
function renameSpecFields(specJson: string): string | undefined {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(specJson) as Record<string, unknown>;
  } catch {
    return undefined; // not a spec this can repair; validation will say so in its own words
  }
  let changed = false;
  for (const [from, to] of RENAMED_SPEC_FIELDS) {
    if (!(from in spec)) continue;
    // A spec carrying both is already migrated and separately wrong; leave the new field
    // alone and just drop the stale one rather than overwriting what someone set.
    if (!(to in spec)) spec[to] = spec[from];
    delete spec[from];
    changed = true;
  }
  return changed ? JSON.stringify(spec) : undefined;
}

/**
 * Selects on the presence of a spec rather than on `event = 'agent.spawned'`, so it does not
 * depend on the event-name migration having already run in this process.
 */
export function migrateAgentSpecs(db: Database): number {
  const rows = db
    .query<{ seq: number; payload: string }, []>(
      `SELECT seq, payload FROM ledger WHERE payload LIKE '%"specJson"%'`,
    )
    .all();

  const update = db.query<void, [string, number]>(`UPDATE ledger SET payload = ? WHERE seq = ?`);

  let changed = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof payload.specJson !== "string") continue;
      const rewritten = renameSpecFields(payload.specJson);
      if (rewritten === undefined) continue;
      payload.specJson = rewritten;
      update.run(JSON.stringify(payload), row.seq);
      changed++;
    }
  });
  run();
  return changed;
}
