/**
 * `alineo init` / `init` — starts OpenSandbox + alineod locally via Docker and writes
 * `alineo.config.json`. Shared verbatim by `alineo-cli` (`packages/cli/src/commands/init.ts`,
 * which logs to stdout) and `alineo-mcp` (`packages/mcp/src/init.ts`, which collects a log array
 * instead — an MCP stdio server's stdout is the JSON-RPC channel, so tool handlers must never
 * `console.log`) via the injectable `log` callback, so the two can never drift apart the way two
 * hand-copied files did before.
 */
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import {
  checkDocker,
  getContainerState,
  startContainer,
  restartContainer,
  removeContainer,
  runContainer,
  pullImage,
  pollHealth,
  isReachable,
} from "./docker.js";
import {
  configPath,
  writeConfig,
  serverConfigDir,
  serverConfigPath,
  serverConfigContent,
  serverDataDir,
} from "./config.js";
import { PI_MODEL_API_KEY_ENV_VARS } from "./pi-model-keys.js";

export type Log = (message: string) => void;

export const OPENSANDBOX_CONTAINER_NAME = "alineo-opensandbox";
// 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first,
// and OpenSandbox only listens on IPv4.
export const SERVER_URL = "http://127.0.0.1:8080";

export const ALINEOD_CONTAINER_NAME = "alineo-alineod";
export const ALINEOD_IMAGE = "ghcr.io/drejt/alineod:latest";
export const ALINEOD_URL = "http://127.0.0.1:4600";
const isAlineodHealthy = (body: unknown): boolean => (body as { ok?: boolean } | null)?.ok === true;

// Bridge-network fallback address for both alineod (to reach OpenSandbox) and OpenSandbox's own
// `eip` (see `usesHostNetworking`'s doc comment) — computed once and threaded through so the two
// can never drift apart.
export const HOST_DOCKER_INTERNAL_SERVER_URL = "http://host.docker.internal:8080";

/**
 * `--network host` (which makes alineod see `127.0.0.1` exactly as the host does, matching
 * OpenSandbox's configured `eip` — see `ensureAlineod`'s doc comment) only works out of the box
 * on native Linux Docker. Docker Desktop for Windows/Mac ships it behind an opt-in "Enable host
 * networking" setting nothing here can safely toggle (no stable, documented way to flip it and
 * restart Docker Desktop from a CLI); without it, `--network host` containers report "running"
 * but publish no ports the host can reach at all (see the `isReachable` probe below, which is
 * exactly what catches this class of failure). Keying off `process.platform` instead of probing
 * Docker's own networking capabilities is a heuristic, not a guarantee (e.g. Docker Desktop for
 * Linux may behave like Windows/Mac here too) — but it matches how the overwhelming majority of
 * each platform's users actually run Docker. `ensureAlineod` backs this guess with a live
 * reachability probe and falls back to bridge networking on the spot if it's wrong, so a bad
 * guess self-heals instead of leaving alineod permanently unreachable.
 */
export const usesHostNetworking = process.platform !== "win32" && process.platform !== "darwin";

export interface InitResult {
  serverUrl: string;
  alineodUrl: string;
}

export async function runInit(log: Log): Promise<InitResult> {
  log("Checking Docker...");
  await checkDocker();

  const openSandboxConfigChanged = await ensureServerConfig();
  await ensureServerDataDir();

  const state = await getContainerState(OPENSANDBOX_CONTAINER_NAME);

  if (state === "running") {
    if (openSandboxConfigChanged) {
      log("OpenSandbox networking config changed — restarting to apply it...");
      await restartContainer(OPENSANDBOX_CONTAINER_NAME);
      log("Waiting for OpenSandbox to be ready...");
      await pollHealth(`${SERVER_URL}/health`);
    } else {
      log(`OpenSandbox already running at ${SERVER_URL}`);
    }
  } else if (state === "stopped") {
    log("Restarting OpenSandbox container...");
    await startContainer(OPENSANDBOX_CONTAINER_NAME);
    log("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  } else {
    log("Starting OpenSandbox in Docker...");

    await runContainer(
      [
        "-d",
        "--name",
        OPENSANDBOX_CONTAINER_NAME,
        "-p",
        "8080:8080",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${serverConfigPath()}:/etc/opensandbox/config.toml:ro`,
        // Persists OpenSandbox's own snapshot-metadata db (see serverDataDir()'s doc
        // comment) across the container being recreated, not just stopped/started.
        "-v",
        `${serverDataDir()}:/data`,
        "-e",
        "SANDBOX_CONFIG_PATH=/etc/opensandbox/config.toml",
        "-e",
        "OPENSANDBOX_INSECURE_SERVER=YES",
        "opensandbox/server:latest",
      ],
      "OpenSandbox container",
    );
    log("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  }

  await ensureAlineod(log, openSandboxConfigChanged);
  await ensureProjectConfig(log);
  log(`OpenSandbox running at ${SERVER_URL}, alineod running at ${ALINEOD_URL} — ready.`);

  return { serverUrl: SERVER_URL, alineodUrl: ALINEOD_URL };
}

/**
 * alineod needs to reach OpenSandbox at the same address OpenSandbox's own configured `eip`
 * uses — that's what it hands back in every sandbox proxy URL (`{eip}/sandboxes/{id}/proxy/{port}`,
 * see `apps/alineod/README.md`'s "Networking caveat"), and alineod follows those literally.
 *
 * - **Linux**: `--network host` puts alineod's `127.0.0.1` in the same namespace as the host's,
 *   matching `eip` (`SERVER_URL`, `ensureServerConfig` below) exactly — same as a bare `bun run
 *   start` would see. No extra port publishing needed; alineod's own port is already the host's.
 * - **Windows/Mac (Docker Desktop)**: `--network host` doesn't publish container ports to the
 *   host at all without a setting this can't safely flip (see `usesHostNetworking`'s doc
 *   comment) — every ALINEOD_URL health check would time out, exactly what motivated this split.
 *   Instead alineod stays on the default bridge network with an explicit `-p 4600:4600` (so the
 *   host can reach *it*) and reaches OpenSandbox via `host.docker.internal`, which Docker
 *   Desktop resolves to the host on every container regardless of network mode — no host
 *   networking feature required. `ensureServerConfig` sets OpenSandbox's `eip` to the same
 *   `host.docker.internal` address so alineod can also follow the proxy URLs it hands back.
 *   Trade-off: a host-based client talking to *this same* OpenSandbox instance directly (not
 *   through alineod) can no longer follow those proxy URLs either, since the host itself can't
 *   reliably resolve `host.docker.internal` back to itself (Windows routes it via the LAN
 *   interface, which most local networks don't hairpin NAT back to the same machine) — use `uvx
 *   opensandbox-server` instead for that case (see the root CLAUDE.md's "Local OpenSandbox
 *   setup").
 */
async function ensureAlineod(log: Log, openSandboxConfigChanged: boolean): Promise<void> {
  const state = await getContainerState(ALINEOD_CONTAINER_NAME);

  if (state !== "missing" && openSandboxConfigChanged) {
    log("OpenSandbox networking config changed — recreating alineod to match...");
    await removeContainer(ALINEOD_CONTAINER_NAME);
  } else if (state === "running") {
    if (await isReachable(`${ALINEOD_URL}/health`, isAlineodHealthy)) {
      log(`alineod already running at ${ALINEOD_URL}`);
      return;
    }
    // Docker reports "running", but nothing answers — most often the exact Windows/Mac
    // `--network host` failure mode this split exists to avoid on a fresh init, or a container
    // left over from before this fix. Recreating (not just restarting) is what actually changes
    // its network mode — `docker restart` reapplies the same args the container already has.
    log("alineod is running but not reachable — recreating it...");
    await removeContainer(ALINEOD_CONTAINER_NAME);
  } else if (state === "stopped") {
    log("Restarting alineod container...");
    await startContainer(ALINEOD_CONTAINER_NAME);
    log("Waiting for alineod to be ready...");
    await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
    return;
  }

  log(`Pulling ${ALINEOD_IMAGE}...`);
  await pullImage(ALINEOD_IMAGE);

  // Model-agnostic: forward whatever Pi-supported provider key(s) are already in the
  // operator's shell. An AgentSpec's env map (e.g. `{ NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }`)
  // is resolved from process.env inside whichever process calls Alineo.start()/.spawn() —
  // for a swarm run through alineod, that's this container — so any provider works as long
  // as Pi supports it, not just NVIDIA's free tier.
  const foundModelKeys = PI_MODEL_API_KEY_ENV_VARS.filter((name) => process.env[name]);
  const modelKeyArgs = foundModelKeys.flatMap((name) => ["-e", `${name}=${process.env[name]}`]);
  if (foundModelKeys.length > 0) {
    log(`Forwarding model key(s): ${foundModelKeys.join(", ")}`);
  } else {
    log(
      "No known model API key found in the environment — alineod will start, but agent " +
        "specs referencing a provider key will fail until one is set (see any of the env " +
        "vars in pi-model-keys.ts).",
    );
  }

  log("Starting alineod in Docker...");
  await startAlineodContainer(usesHostNetworking, modelKeyArgs);
  log("Waiting for alineod to be ready...");

  if (usesHostNetworking && !(await isReachable(`${ALINEOD_URL}/health`, isAlineodHealthy))) {
    // The platform guess (see `usesHostNetworking`'s doc comment) turned out wrong for this
    // Docker install (e.g. Docker Desktop for Linux) — fall back to bridge networking instead of
    // leaving alineod permanently unreachable until someone notices and recreates it by hand.
    log(
      "alineod isn't reachable over host networking on this Docker install — falling back to " +
        "bridge networking + host.docker.internal...",
    );
    await removeContainer(ALINEOD_CONTAINER_NAME);
    if (await ensureServerEip(HOST_DOCKER_INTERNAL_SERVER_URL)) {
      log("OpenSandbox eip changed to match — restarting to apply it...");
      await restartContainer(OPENSANDBOX_CONTAINER_NAME);
      await pollHealth(`${SERVER_URL}/health`);
    }
    await startAlineodContainer(false, modelKeyArgs);
  }

  await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
}

function startAlineodContainer(useHostNetworking: boolean, modelKeyArgs: string[]): Promise<void> {
  const networkArgs = useHostNetworking
    ? ["--network", "host"]
    : ["-p", "4600:4600", "--add-host", "host.docker.internal:host-gateway"];
  const alineodServerUrl = useHostNetworking ? SERVER_URL : HOST_DOCKER_INTERNAL_SERVER_URL;

  return runContainer(
    [
      "-d",
      "--name",
      ALINEOD_CONTAINER_NAME,
      ...networkArgs,
      "-e",
      `ALINEO_SERVER_URL=${alineodServerUrl}`,
      "-e",
      "ALINEO_USE_SERVER_PROXY=true",
      ...modelKeyArgs,
      "-v",
      "alineod-data:/data",
      ALINEOD_IMAGE,
    ],
    "alineod container",
  );
}

/** Ensures `server.toml`'s `eip` matches what this platform needs (see `ensureAlineod`'s doc
 * comment) — returns whether it changed, so callers can restart whatever already-running
 * containers depend on it. */
async function ensureServerConfig(): Promise<boolean> {
  const dir = serverConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const eip = usesHostNetworking ? SERVER_URL : HOST_DOCKER_INTERNAL_SERVER_URL;
  return ensureServerEip(eip);
}

/**
 * Creates `server.toml` from the default template if it doesn't exist yet, or otherwise patches
 * only its `eip = "..."` line in place — the rest of an existing file is left untouched, since
 * its own header comments invite hand-editing it for `networkPolicy`/`credentialProxy`/egress
 * tuning, and clobbering that on every `init` would silently discard it. Returns whether the eip
 * actually changed.
 */
async function ensureServerEip(eip: string): Promise<boolean> {
  const path = serverConfigPath();
  if (!existsSync(path)) {
    await Bun.write(path, serverConfigContent(eip));
    return true;
  }

  const existing = await Bun.file(path).text();
  const eipLine = /^eip\s*=\s*"([^"]*)"/m;
  if (existing.match(eipLine)?.[1] === eip) return false;

  const updated = eipLine.test(existing)
    ? existing.replace(eipLine, `eip = "${eip}"`)
    : existing.replace(/^\[server\]/m, `[server]\neip = "${eip}"`);
  await Bun.write(path, updated);
  return true;
}

/**
 * Host-side half of the `serverDataDir()` bind mount. `docker run -v` would auto-create
 * a missing host path anyway, but doing it explicitly here matches `ensureServerConfig()`'s
 * pattern and keeps directory creation in one place rather than relying on Docker's
 * legacy-`-v`-specific behavior (unlike `--mount`, which requires the source to pre-exist).
 */
async function ensureServerDataDir(): Promise<void> {
  const dir = serverDataDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function ensureProjectConfig(log: Log): Promise<void> {
  if (!existsSync(configPath())) {
    await writeConfig({
      serverUrl: SERVER_URL,
      useServerProxy: true,
      apiKey: "",
      adapterPath: "./.alineo/ledger.db",
      agentsDir: "./agents",
      defaults: {
        resources: { cpu: "1000m", memory: "1Gi" },
      },
    });
    log("Created alineo.config.json");
  }
}
