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

export async function runContainer(args: string[]): Promise<void> {
  const { ok, stderr } = await spawn(["docker", "run", ...args]);
  if (!ok) throw new Error(`Failed to start OpenSandbox container: ${stderr.trim()}`);
}

export async function pollHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "healthy") return;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }
  throw new Error(`OpenSandbox did not become healthy within ${timeoutMs / 1_000}s`);
}
