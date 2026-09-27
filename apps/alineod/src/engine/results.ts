/**
 * Result storage. When an agent's turn ends, alineod stores its last assistant
 * text as an inline blob and hands waiters a `resultRef`.
 *
 * D-d in research/daemon.md: the real implementation resolves a by-reference
 * `fs://<agentId>/<path>` into the agent's sandbox (OpenSandbox cross-sandbox read or a
 * copy-out). This inline form is a stand-in so fan-out/gather works end to end.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { WORK_DIR } from "../../config";

const RESULTS_DIR = join(WORK_DIR, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

function pathFor(agentId: string): string {
  return join(RESULTS_DIR, `${agentId}.md`);
}

/**
 * Persist a result blob; returns the `resultRef` to store on the handle.
 *
 * The caller records `handle.settled` in the ledger right after this returns, so the blob must
 * already be on disk by then: a crash between the two must never leave a settled handle pointing
 * at a missing or half-written file. Write to a temp file, fsync it, rename over the target, then
 * fsync the directory so the rename itself is durable.
 */
export function writeResult(agentId: string, text: string | null): string {
  const target = pathFor(agentId);
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text ?? "");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  // Windows can't open a directory to fsync it; NTFS journals the rename itself.
  if (process.platform === "win32") return `fs://${agentId}/result.md`;
  const dirFd = openSync(RESULTS_DIR, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  // Shaped like the real scheme even though it resolves to a local file for now.
  return `fs://${agentId}/result.md`;
}

/** Resolve a `resultRef` back to its text. Currently ignores the ref shape and reads the stored blob. */
export function readResult(agentId: string): string | null {
  const p = pathFor(agentId);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
