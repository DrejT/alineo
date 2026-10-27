/**
 * Re-grade a saved rows.json after a verifier bug is found, without re-running agents. Every correction is
 * named, applied only to rows whose recorded verifier output matches it exactly, and the original verdict is
 * kept in `passedStrict` so the change stays visible.
 *
 * Usage: bun src/regrade.ts results/outcome-all-<run>/rows.json
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeOutput } from "./normalize.ts";
import type { OutcomeRow } from "./outcome.ts";

export interface Correction {
  name: string;
  task: string;
  /** Verifier outputs that are in fact correct (the check was too strict about them). */
  acceptOutput: string[];
}

export const CORRECTIONS: Correction[] = [
  {
    name: "csv-aggregate: the verifier compared int 50 with float 50.0; the agent wrote the JSON number 50",
    task: "csv-aggregate",
    acceptOutput: ["[('books', 20.5), ('food', 19.75), ('tools', 50)]"],
  },
];

export type Regraded = OutcomeRow & { passedStrict?: boolean; regradeNote?: string };

export function regrade(rows: OutcomeRow[], corrections = CORRECTIONS): Regraded[] {
  return rows.map((r) => {
    const c = corrections.find((x) => x.task === r.task && x.acceptOutput.map(normalizeOutput).includes(normalizeOutput(r.verifyOutput)));
    if (!c || r.agentOutcome !== "success" || r.passed) return r;
    return { ...r, passedStrict: r.passed, passed: true, outputCorrect: true, regradeNote: c.name };
  });
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun src/regrade.ts <rows.json>");
    process.exit(2);
  }
  const backup = path.replace(/rows\.json$/, "rows.original.json");
  if (!existsSync(backup)) copyFileSync(path, backup);
  const original = JSON.parse(readFileSync(backup, "utf8")) as OutcomeRow[];
  const out = regrade(original);
  writeFileSync(path, JSON.stringify(out, null, 2));
  const changed = out.filter((r) => r.regradeNote);
  console.log(`regraded ${changed.length} of ${out.length} rows (original kept at ${backup})`);
  for (const r of changed) console.log(`  ${r.task}#${r.repeat}: ${r.regradeNote}`);
  console.log(`pass rate: ${out.filter((r) => r.passed).length}/${out.length} (strict: ${original.filter((r) => r.passed).length}/${original.length})`);
}
