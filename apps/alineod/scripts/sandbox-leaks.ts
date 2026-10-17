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
 * `--close` deletes the leaked ones through the provider (not `docker rm`, so the provider's own
 * records stay consistent). Exits 1 when anything is leaked or missing, so it can run from
 * cron and alert. Reads ALINEOD_DB_PATH like the daemon. The provider comes from the project
 * config, like the daemon's: ALINEO_PROVIDER, ALINEO_SERVER_URL (default http://127.0.0.1:8080)
 * and ALINEO_API_KEY in the environment, or `alineo.config.json`.
 */
import { Database } from "bun:sqlite";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { providerFromConfig } from "@alineo-labs/sandbox";
import { DB_PATH } from "../config";
import { classify, closeSandbox, listLiveSandboxes } from "../src/ops/leaks";

const close = process.argv.includes("--close");
const asJson = process.argv.includes("--json");
const provider = providerFromConfig(loadProjectConfig());

const db = new Database(DB_PATH, { readonly: true });
const report = classify(db, await listLiveSandboxes(provider));
db.close();

const leaked = report.sandboxes.filter((s) => s.verdict === "leaked");
const closed: string[] = [];
if (close) {
  for (const s of leaked) {
    await closeSandbox(provider, s.sandboxId);
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
