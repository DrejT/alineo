import { execFileSync } from "node:child_process";
import os from "node:os";

export interface Manifest {
  runId: string;
  startedAt: string;
  gitSha: string | null;
  host: {
    platform: string;
    release: string;
    cpuModel: string;
    cpus: number;
    totalMemGiB: number;
  };
  docker: { cpus: number; memGiB: number; serverVersion: string } | null;
  runtime: { bun: string | null; node: string };
  /** Free-form knobs for this run (image, resources, levels...). */
  params: Record<string, unknown>;
}

function tryExec(cmd: string, args: string[], timeout = 8000): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Docker's view of its own VM (on Docker Desktop this is the WSL2 limit, the real ceiling). */
export function dockerInfo(timeout = 8000): Manifest["docker"] {
  const raw = tryExec(
    "docker",
    ["info", "--format", "{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}"],
    timeout,
  );
  if (!raw) return null;
  const [cpus, mem, version] = raw.split(" ");
  if (!cpus || !mem || Number(cpus) === 0) return null;
  return {
    cpus: Number(cpus),
    memGiB: Math.round((Number(mem) / 2 ** 30) * 10) / 10,
    serverVersion: version ?? "unknown",
  };
}

export function collectManifest(params: Record<string, unknown> = {}): Manifest {
  const cpus = os.cpus();
  const startedAt = new Date().toISOString();
  return {
    runId: startedAt.replace(/[:.]/g, "-"),
    startedAt,
    gitSha: tryExec("git", ["rev-parse", "--short", "HEAD"]),
    host: {
      platform: `${os.platform()} ${os.arch()}`,
      release: os.release(),
      cpuModel: cpus[0]?.model.trim() ?? "unknown",
      cpus: cpus.length,
      totalMemGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    },
    docker: dockerInfo(),
    runtime: { bun: typeof Bun !== "undefined" ? Bun.version : null, node: process.version },
    params,
  };
}

/**
 * Throws unless Docker answers. Docker Desktop can be slow for a moment right after a burst of
 * container teardown, so retry before declaring it dead and aborting a ramp.
 */
export function assertDockerHealthy(attempts = 3): void {
  for (let i = 0; i < attempts; i++) if (dockerInfo(20_000)) return;
  throw new Error("Docker is not responding (is Docker Desktop running?)");
}
