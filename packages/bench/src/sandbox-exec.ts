/** Helpers to look inside an agent's sandbox container from the host (Docker named `sandbox-<id>`). */
import { execFileSync } from "node:child_process";

const container = (sandboxId: string) => `sandbox-${sandboxId}`;

/**
 * Whether the sandbox container is paused. Reads Docker's status with a few retries: a transient `docker inspect`
 * failure used to be reported as "not paused", which made a frozen container look unfrozen. Throws if Docker never answers.
 */
export function isPaused(sandboxId: string): boolean {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return execFileSync("docker", ["inspect", "-f", "{{.State.Status}}", container(sandboxId)], { encoding: "utf8", timeout: 20_000 }).trim() === "paused";
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`docker inspect failed for ${container(sandboxId)}: ${last instanceof Error ? last.message.slice(0, 120) : String(last)}`);
}

/** Run a shell command in the sandbox. Unpauses first unless `keepPaused` (docker refuses exec on a paused container). */
export function sandboxExec(sandboxId: string, script: string, opts: { keepPaused?: boolean } = {}): string {
  if (!opts.keepPaused) {
    try {
      execFileSync("docker", ["unpause", container(sandboxId)], { stdio: "ignore", timeout: 15_000 });
    } catch {
      // not paused
    }
  }
  try {
    return execFileSync("docker", ["exec", container(sandboxId), "bash", "-c", script], { encoding: "utf8", timeout: 60_000 }).trim();
  } catch {
    return "";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
