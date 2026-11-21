/**
 * Print what happened in one run: its agents, then every transcript row and diagnostic event in time order.
 * Run it inside the server container, where the database lives:
 *
 *   docker exec alineo-ui bun scripts/run-report.ts <run_id>
 *   docker exec alineo-ui bun scripts/run-report.ts --latest            the newest run of any user
 *   docker exec alineo-ui bun scripts/run-report.ts --latest test123    the newest run of one user
 *
 * Lines starting with "!!" are warnings or errors. Read the `stream.end`, `turn.cut_short` and `pi.retry` lines first
 * when an agent stopped early. This is read only.
 */
import { join } from "node:path";
import { Database } from "bun:sqlite";

const dataDir = process.env.ALINEO_UI_DATA_DIR ?? join(import.meta.dir, "..", "data");
const db = new Database(join(dataDir, "control-plane.db"), { readonly: true });

const args = process.argv.slice(2);
let runId = args[0];
if (!runId || runId === "--latest") {
  const who = args[1];
  const row = (who
    ? db.query(`SELECT r.id FROM runs r JOIN users u ON u.id = r.user_id WHERE u.username = ? ORDER BY r.created_at DESC LIMIT 1`).get(who)
    : db.query(`SELECT id FROM runs ORDER BY created_at DESC LIMIT 1`).get()) as { id: string } | null;
  if (!row) { console.error("No run found."); process.exit(1); }
  runId = row.id;
}

const run = db.query(`SELECT r.*, u.username FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`).get(runId) as Record<string, any> | null;
if (!run) { console.error(`Run ${runId} not found.`); process.exit(1); }

const clip = (v: unknown, n: number) => { const t = String(v ?? "").replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n)}…` : t; };
const hms = (ts: number) => new Date(ts).toISOString().slice(11, 23);

console.log(`RUN ${run.id}  ${run.status.toUpperCase()}  user=${run.username}  model=${run.model}  max=${run.max_agents}`);
console.log(`  started  ${new Date(run.created_at).toISOString()}`);
if (run.finished_at) console.log(`  finished ${new Date(run.finished_at).toISOString()}  (${Math.round((run.finished_at - run.created_at) / 1000)}s)`);
console.log(`  goal     ${clip(run.goal, 200)}`);
console.log(`  summary  ${clip(run.summary, 240) || "(none)"}`);

const nodes = db.query(`SELECT id, role, parent_id, status, state, result FROM sandboxes WHERE run_id = ? ORDER BY uptime_start`).all(runId) as Array<Record<string, any>>;
const names = new Map(nodes.map((n) => [n.id as string, `${String(n.role).slice(0, 18)}:${String(n.id).slice(0, 4)}`]));
console.log(`\nAGENTS (${nodes.length})`);
for (const n of nodes) {
  const events = db.query(`SELECT kind, COUNT(*) c FROM agent_events WHERE sandbox_id = ? GROUP BY kind`).all(n.id) as Array<{ kind: string; c: number }>;
  console.log(`  ${names.get(n.id)!.padEnd(24)} state=${String(n.state).padEnd(7)} ${n.status === "terminated" ? "removed" : n.status}  ${events.map((e) => `${e.kind}=${e.c}`).join(" ")}`);
}

type Line = { ts: number; order: number; text: string };
const lines: Line[] = [];
const ids = nodes.map((n) => n.id as string);
const marks = ids.map(() => "?").join(",") || "''";

for (const r of db.query(`SELECT id, ts, sandbox_id, kind, text FROM agent_events WHERE sandbox_id IN (${marks}) ORDER BY id`).all(...ids) as Array<Record<string, any>>) {
  let detail = r.text;
  let flag = "  ";
  if (r.kind === "tool") { try { const d = JSON.parse(r.text); detail = `${d.tool} ${clip(d.input, 70)}${d.output === undefined ? "  (no result yet)" : `  -> ${clip(d.output, 70)}`}`; if (d.isError) flag = "!!"; } catch { /* keep raw */ } }
  else if (r.kind === "steer") { try { const d = JSON.parse(r.text); detail = `${d.label}: ${clip(d.text, 70)}`; } catch { /* keep raw */ } }
  if (r.kind === "error") flag = "!!";
  lines.push({ ts: r.ts, order: r.id, text: `${hms(r.ts)} ${flag} ${names.get(r.sandbox_id)!.padEnd(24)} ${String(r.kind).padEnd(5)} ${clip(detail, 150)}` });
}
for (const r of db.query(`SELECT id, ts, level, event, sandbox_id, data FROM diag WHERE run_id = ? OR sandbox_id IN (${marks}) ORDER BY id`).all(runId, ...ids) as Array<Record<string, any>>) {
  const who = r.sandbox_id ? names.get(r.sandbox_id) ?? String(r.sandbox_id).slice(0, 8) : "(server)";
  lines.push({ ts: r.ts, order: 1e9 + r.id, text: `${hms(r.ts)} ${r.level === "warn" || r.level === "error" ? "!!" : "  "} ${String(who).padEnd(24)} ${String(r.event).padEnd(18)} ${clip(r.data, 260)}` });
}
lines.sort((a, b) => a.ts - b.ts || a.order - b.order);
console.log(`\nTIMELINE (${lines.length} rows)`);
for (const l of lines) console.log(l.text);
