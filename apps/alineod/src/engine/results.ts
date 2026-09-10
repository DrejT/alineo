/**
 * Prototype result storage. When an agent's turn ends, alineod stores its last assistant
 * text as an inline blob and hands waiters a `resultRef`.
 *
 * D-d in research/daemon.md: the real implementation resolves a by-reference
 * `fs://<agentId>/<path>` into the agent's sandbox (OpenSandbox cross-sandbox read or a
 * copy-out). This inline form is a stand-in so fan-out/gather works end to end.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WORK_DIR } from "../../config";

const RESULTS_DIR = join(WORK_DIR, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

function pathFor(agentId: string): string {
  return join(RESULTS_DIR, `${agentId}.md`);
}

/** Persist a result blob; returns the `resultRef` to store on the handle. */
export function writeResult(agentId: string, text: string | null): string {
  writeFileSync(pathFor(agentId), text ?? "");
  // Shaped like the real scheme even though it resolves to a local file for now.
  return `fs://${agentId}/result.md`;
}

/** Resolve a `resultRef` back to its text. Prototype: ignores the ref shape, reads the blob. */
export function readResult(agentId: string): string | null {
  const p = pathFor(agentId);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
