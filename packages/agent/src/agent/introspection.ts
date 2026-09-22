import type { PiMessage, PiSessionState, PiSlashCommand, SessionStats } from "../types";
import type { AgentInternal } from "./internal";

/** Retrieve token usage, cost, and message counts for the current session. */
export async function getSessionStats(a: AgentInternal): Promise<SessionStats> {
  return a.adapter.getSessionStats();
}

/** Retrieve the text of Pi's most recent assistant response. Returns `null` if none yet. */
export async function getLastAssistantText(a: AgentInternal): Promise<string | null> {
  return a.adapter.getLastAssistantText();
}

/**
 * List the points in the current session a conversation can be branched from.
 * Each entry has `entryId` (pass to `branchSession()`) and `text` (the message there).
 *
 * `a.adapter.getForkMessages` keeps Pi's own name — the adapter speaks the harness's
 * vocabulary, alineo speaks its own on the way out.
 */
export async function getBranchPoints(
  a: AgentInternal,
): Promise<{ entryId: string; text: string }[]> {
  return a.adapter.getForkMessages();
}

/** List Pi's available slash commands, including extensions, prompt templates, and skills. */
export async function getCommands(a: AgentInternal): Promise<PiSlashCommand[]> {
  return a.adapter.getCommands();
}

/** Retrieve Pi's full conversation history for the current session. */
export async function getMessages(a: AgentInternal): Promise<PiMessage[]> {
  return a.adapter.getMessages();
}

/**
 * Retrieve Pi's current session state: active model, thinking level, streaming/compaction
 * status, queue modes, and session identity. The only piece of Pi's RPC surface with no
 * other way to observe the *current* model or thinking level (as opposed to the full list).
 */
export async function getState(a: AgentInternal): Promise<PiSessionState> {
  return a.adapter.getState();
}

/** Retrieve recent bridge logs (ring-buffered, last 200 entries). */
export async function getLogs(a: AgentInternal): Promise<string> {
  return a.adapter.getLogs();
}
