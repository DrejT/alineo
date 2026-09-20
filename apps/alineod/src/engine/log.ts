/**
 * What alineod says about a swarm while it runs. Every state change already flows through
 * `emit()` (ledger → projection → SSE bus); this is the same fact as one log line, so an operator
 * tailing the daemon can follow a run without subscribing to its event stream.
 *
 * Only a small allowlist of scalar payload fields is ever logged. Prompts, specs, steer messages
 * and results can be large or sensitive and stay in the ledger — never here.
 */
import { getLogger } from "@alineo-labs/logger";
import type { LevelName } from "@alineo-labs/logger";

const log = getLogger("alineod");

const MAX_FIELD_CHARS = 200;

/** Payload fields that are small, scalar, and safe to print. */
const LOGGED_FIELDS = [
  "outcome",
  "from",
  "to",
  "reason",
  "error",
  "specName",
  "parentAgentId",
  "sandboxId",
  "depth",
  "spawnIndex",
  "resultRef",
  "dimension",
] as const;

function pick(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of LOGGED_FIELDS) {
    const value = payload[key];
    if (typeof value === "string") {
      out[key] = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function levelFor(event: string, payload: Record<string, unknown>): LevelName {
  if (event === "budget_denied") return "warn";
  if (event === "agent_ended") {
    // a user stop ("aborted") is expected; failed / lost / budget-exceeded are not
    return payload.outcome === "success" || payload.outcome === "aborted" ? "info" : "warn";
  }
  // bookkeeping that fires constantly during a coordinated run
  if (/^(inbox_|wait_|notify_)/.test(event)) return "debug";
  return "info";
}

/** One line per alineod ledger event: `[alineod] agent_ended runId=… agentId=… seq=… outcome=success`. */
export function logEvent(
  runId: string,
  agentId: string | null,
  event: string,
  payload: Record<string, unknown>,
  seq: number,
): void {
  const level = levelFor(event, payload);
  if (!log.isEnabled(level)) return;
  log[level](event, { runId, agentId: agentId ?? undefined, seq, ...pick(payload) });
}

/** Persisted harness events (turns, tool calls) — debug only; tool *names*, never arguments. */
export function logHarnessEvent(
  runId: string,
  agentId: string,
  type: string,
  ev: Record<string, unknown>,
): void {
  if (!log.isEnabled("debug")) return;
  const fields: Record<string, string | boolean> = {};
  if (typeof ev.toolName === "string") fields.toolName = ev.toolName;
  if (typeof ev.isError === "boolean") fields.isError = ev.isError;
  log.debug(type, { runId, agentId, ...fields });
}
