/**
 * Server logging. One JSON object per line on stdout (`docker logs alineo-ui`), so a line can be filtered with grep or jq.
 * Events marked `persist` also go into the `diag` table, which outlives log rotation and is what `scripts/run-report.ts`
 * reads. These logs stay on the server: they name the model behind each Gemini label, which no API route returns.
 */
import { db } from "./db";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.ALINEO_UI_LOG_LEVEL ?? "info").toLowerCase() as Level;
const MIN = ORDER[configured] ?? ORDER.info;

/** Never write the model key to a log line, in any form it might appear. */
function redact(text: string): string {
  const key = process.env.NVIDIA_API_KEY;
  let out = key ? text.split(key).join("[hidden]") : text;
  out = out.replace(/nvapi-[A-Za-z0-9_-]+/g, "[hidden]");
  return out.replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"']+/gi, "$1[hidden]");
}

/** Cut long text so one event cannot fill the log. */
export function clipText(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

export interface LogFields {
  user?: string;
  sandbox?: string;
  run?: string;
  [key: string]: unknown;
}

export function log(level: Level, event: string, fields: LogFields = {}, persist = false): void {
  if (ORDER[level] < MIN && !persist) return;
  const { user, sandbox, run, ...rest } = fields;
  const record = { ts: new Date().toISOString(), level, event, user, sandbox, run, ...rest };
  let line: string;
  try { line = redact(JSON.stringify(record)); } catch { line = JSON.stringify({ ts: record.ts, level, event, note: "fields could not be serialized" }); }
  if (ORDER[level] >= MIN) (ORDER[level] >= ORDER.warn ? console.error : console.log)(line);
  if (persist) {
    try {
      db.prepare(`INSERT INTO diag (ts, level, event, user_id, sandbox_id, run_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(Date.now(), level, event, user ?? null, sandbox ?? null, run ?? null, redact(JSON.stringify(rest)));
    } catch { /* a logging failure must never break the operation being logged */ }
  }
}

/** Time something. Call the returned function to get the elapsed milliseconds. */
export function timer(): () => number {
  const t0 = performance.now();
  return () => Math.round(performance.now() - t0);
}
