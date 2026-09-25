/**
 * Compare alineod's ledger with the sandboxes OpenSandbox actually has.
 *
 *   bun apps/alineod/scripts/sandbox-leaks.ts [--close] [--json]
 *
 *   in-use   alineod still needs it
 *   leaked   alineod is done with it (aborted, lost, released) but it still exists
 *   foreign  alineod has never heard of it — another client's, or a deleted run's. Never closed.
 *   missing  alineod still needs a sandbox OpenSandbox no longer has
 *
 * `--close` deletes the leaked ones through the OpenSandbox API (not `docker rm`, so OpenSandbox's
 * own records stay consistent). Exits 1 when anything is leaked or missing, so it can run from
 * cron and alert. Reads ALINEOD_DB_PATH like the daemon; ALINEO_SERVER_URL (default
 * http://127.0.0.1:8080) and ALINEO_API_KEY for OpenSandbox.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import { classify, closeSandbox, listLiveSandboxes } from "../src/ops/leaks";

const close = process.argv.includes("--close");
const asJson = process.argv.includes("--json");
const serverUrl = (process.env.ALINEO_SERVER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const apiKey = process.env.ALINEO_API_KEY ?? "";

const db = new Database(DB_PATH, { readonly: true });
const report = classify(db, await listLiveSandboxes(serverUrl, apiKey));
db.close();

const leaked = report.sandboxes.filter((s) => s.verdict === "leaked");
const closed: string[] = [];
if (close) {
  for (const s of leaked) {
    await closeSandbox(serverUrl, apiKey, s.sandboxId);
    closed.push(s.sandboxId);
  }
}

if (asJson) {
  console.log(JSON.stringify({ ...report, closed }, null, 2));
} else {
  const count = (v: string) => report.sandboxes.filter((s) => s.verdict === v).length;
  console.log(
    `${report.sandboxes.length} sandboxes: ${count("in-use")} in use, ${leaked.length} leaked, ` +
      `${count("foreign")} foreign; ${report.missing.length} missing`,
  );
  for (const s of report.sandboxes.filter((s) => s.verdict !== "in-use")) {
    const who = s.agentId ? `agent ${s.agentId} (${s.agentState}, ${s.outcome ?? "live"})` : "";
    const done = closed.includes(s.sandboxId) ? "  -> closed" : "";
    console.log(`  ${s.verdict.padEnd(7)} ${s.sandboxId}  ${s.state}  ${who}${done}`);
  }
  for (const m of report.missing) {
    console.log(`  missing ${m.sandboxId}  agent ${m.agentId} (${m.agentState}) in run ${m.runId}`);
  }
  if (leaked.length > 0 && !close) console.log("re-run with --close to delete the leaked ones");
}

process.exit(leaked.length > closed.length || report.missing.length > 0 ? 1 : 0);
