import type { CompactResult } from "../types";
import { toShellExports } from "../adapters/pi";
import type { AgentInternal } from "./internal";

/**
 * Fork Pi's session at the given entry ID, creating a new branch.
 * Returns the text of the forked message and whether the fork was cancelled.
 */
export async function fork(
  a: AgentInternal,
  entryId: string,
): Promise<{ text: string; cancelled: boolean }> {
  return a.adapter.fork(entryId);
}

/** Clone the current Pi session into a new branch at the current position. */
export async function clone(a: AgentInternal): Promise<{ cancelled: boolean }> {
  return a.adapter.clone();
}

/** Switch Pi to a different session file on disk. */
export async function switchSession(
  a: AgentInternal,
  sessionPath: string,
): Promise<{ cancelled: boolean }> {
  return a.adapter.switchSession(sessionPath);
}

/**
 * Export a static HTML transcript of the current session to the sandbox filesystem.
 * Returns the container path of the generated file — use `agent.sandbox.readFile(path)`
 * to retrieve it.
 */
export async function exportHtml(a: AgentInternal, outputPath?: string): Promise<{ path: string }> {
  return a.adapter.exportHtml(outputPath);
}

/** Manually trigger Pi's context compaction. */
export async function compact(
  a: AgentInternal,
  customInstructions?: string,
): Promise<CompactResult> {
  return a.adapter.compact(customInstructions);
}

/**
 * Set or update env vars in the running container. Writes to /etc/alineo-env and restarts
 * the Pi subprocess so it picks up the new env. Waits until Pi is ready before returning.
 */
export async function setEnv(a: AgentInternal, vars: Record<string, string>): Promise<void> {
  a.env = { ...a.env, ...vars };
  await a.sandbox.writeFile("/etc/alineo-env", toShellExports(a.env));
  await a.adapter.reloadEnv(a.env);
}

/** Delete the sandbox container and release all resources. Always call in a `finally` block. */
export async function close(a: AgentInternal): Promise<void> {
  // Force-shut any prompt()/bash() streams left dangling by sseStream's early-return on
  // `[DONE]` (see PiAdapter.disposeConnections()) -- otherwise those connections can keep
  // the process alive indefinitely even after the sandbox itself is gone.
  a.adapter.disposeConnections();
  await a.sandbox.close();
}
