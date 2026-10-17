import type { CompactResult } from "../types";
import { toShellExports } from "../adapters/pi";
import type { AgentInternal } from "./internal";
import { pi } from "./pi";

/**
 * Branch the harness conversation at the given entry ID.
 *
 * `a.adapter.fork` keeps Pi's own name: the adapter speaks the harness's vocabulary (its
 * bridge endpoint is literally `/fork`), and alineo speaks its own on the way out.
 */
export async function branchSession(
  a: AgentInternal,
  entryId: string,
): Promise<{ text: string; cancelled: boolean }> {
  return pi(a, "fork").fork(entryId);
}

/** Branch the harness conversation at its current position. */
export async function duplicateSession(a: AgentInternal): Promise<{ cancelled: boolean }> {
  return pi(a, "clone").clone();
}

/** Switch Pi to a different session file on disk. */
export async function switchSession(
  a: AgentInternal,
  sessionPath: string,
): Promise<{ cancelled: boolean }> {
  return pi(a, "switchSession").switchSession(sessionPath);
}

/**
 * Export a static HTML transcript of the current session to the sandbox filesystem.
 * Returns the container path of the generated file — use `agent.sandbox.readFile(path)`
 * to retrieve it.
 */
export async function exportHtml(a: AgentInternal, outputPath?: string): Promise<{ path: string }> {
  return pi(a, "exportHtml").exportHtml(outputPath);
}

/** Manually trigger Pi's context compaction. */
export async function compact(
  a: AgentInternal,
  customInstructions?: string,
): Promise<CompactResult> {
  return pi(a, "compact").compact(customInstructions);
}

/**
 * Set or update env vars in the running container. Writes to /etc/alineo-env and restarts
 * the Pi subprocess so it picks up the new env. Waits until Pi is ready before returning.
 */
export async function setEnv(a: AgentInternal, vars: Record<string, string>): Promise<void> {
  a.env = { ...a.env, ...vars };
  await a.sandbox.writeFile("/etc/alineo-env", toShellExports(a.env));
  await pi(a, "reloadEnv").reloadEnv(a.env);
}

/** Delete the sandbox container and release all resources. Always call in a `finally` block. */
export async function close(a: AgentInternal): Promise<void> {
  // Force-shut any prompt()/bash() streams left dangling by sseStream's early-return on
  // `[DONE]` (see PiAdapter.disposeConnections()) -- otherwise those connections can keep
  // the process alive indefinitely even after the sandbox itself is gone.
  a.adapter.dispose();
  // Stop the egress-approval listener (if any) before the sandbox goes away — its port must
  // not outlive the agent.
  await a.egressGate?.stop().catch(() => {});
  await a.sandbox.close();
}
