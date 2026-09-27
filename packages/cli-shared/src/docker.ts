export type ContainerState = "running" | "stopped" | "missing";

async function spawn(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let proc;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(`'${cmd[0]}' not found — is Docker installed?`);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

export async function checkDocker(): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "info"]);
  if (!ok) {
    if (
      stderr.includes("Cannot connect") ||
      stderr.includes("daemon") ||
      stderr.includes("socket")
    ) {
      throw new Error("Docker daemon is not running. Start Docker and try again.");
    }
    throw new Error("Docker is not available. Install Docker and try again.");
  }
}

export async function getContainerState(name: string): Promise<ContainerState> {
  const { ok, stdout } = await spawn(["docker", "inspect", name, "--format", "{{.State.Status}}"]);
  if (!ok) return "missing";
  const status = stdout.trim();
  return status === "running" ? "running" : "stopped";
}

export async function startContainer(name: string): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "start", name]);
  if (!ok) throw new Error(`Failed to start container '${name}': ${stderr.trim()}`);
}

export async function restartContainer(name: string): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "restart", name]);
  if (!ok) throw new Error(`Failed to restart container '${name}': ${stderr.trim()}`);
}

/** Force-removes a container regardless of running/stopped state — used to recreate one whose
 * config (network mode, env) needs to change, since `docker run` args can't be applied in place. */
export async function removeContainer(name: string): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "rm", "-f", name]);
  if (!ok) throw new Error(`Failed to remove container '${name}': ${stderr.trim()}`);
}

/**
 * Set a container's restart policy in place (`docker update`, no recreate). Used so containers
 * created before `init` started passing `--restart` still come back after a reboot.
 */
export async function setRestartPolicy(
  name: string,
  policy: "unless-stopped" | "no",
): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "update", "--restart", policy, name]);
  if (!ok) throw new Error(`Failed to set restart policy on '${name}': ${stderr.trim()}`);
}

export async function runContainer(args: string[], label = "container"): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "run", ...args]);
  if (!ok) throw new Error(`Failed to start ${label}: ${stderr.trim()}`);
}

export async function pullImage(image: string): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "pull", image]);
  if (!ok) throw new Error(`Failed to pull '${image}': ${stderr.trim()}`);
}

/** Default health predicate: OpenSandbox's `/health` returns `{ status: "healthy" }`. */
const isOpenSandboxHealthy = (body: unknown): boolean =>
  (body as { status?: string } | null)?.status === "healthy";

export async function pollHealth(
  url: string,
  timeoutMs = 60_000,
  isHealthy: (body: unknown) => boolean = isOpenSandboxHealthy,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok && isHealthy(await res.json())) return;
    } catch {
      /* not ready yet */
    }
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs / 1_000}s`);
}

/** A quick one-shot version of `pollHealth` for deciding whether an already-`running`
 * container is actually reachable, not just started — a container can report "running" to
 * Docker while its service is unreachable (wrong network mode, crashed process, stale config).
 * 10s (not 3s) so a slow-but-healthy service (host under load, cold Bun startup after reboot,
 * bridge networking still settling) doesn't get misread as unreachable and trigger a destructive
 * `docker rm -f` of an otherwise-fine container. */
export async function isReachable(
  url: string,
  isHealthy?: (body: unknown) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  try {
    await pollHealth(url, timeoutMs, isHealthy);
    return true;
  } catch {
    return false;
  }
}
