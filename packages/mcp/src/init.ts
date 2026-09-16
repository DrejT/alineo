/**
 * `alineo_init` — starts OpenSandbox + alineod locally via Docker and writes
 * `alineo.config.json`. Mirrors `alineo init` (`packages/cli/src/commands/init.ts`) but returns
 * a log of what happened instead of writing to stdout — an MCP stdio server's stdout is the
 * JSON-RPC channel, so tool handlers must never `console.log`.
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

const OPENSANDBOX_CONTAINER_NAME = "alineo-opensandbox";
const SERVER_URL = "http://127.0.0.1:8080";
const ALINEOD_CONTAINER_NAME = "alineo-alineod";
const ALINEOD_IMAGE = "ghcr.io/drejt/alineod:latest";
const ALINEOD_URL = "http://127.0.0.1:4600";
const isAlineodHealthy = (body: unknown): boolean => (body as { ok?: boolean } | null)?.ok === true;

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
 * each platform's users actually run Docker.
 */
const usesHostNetworking = process.platform !== "win32" && process.platform !== "darwin";

export interface InitResult {
  log: string[];
  serverUrl: string;
  alineodUrl: string;
}

export async function init(): Promise<InitResult> {
  const log: string[] = [];
  log.push("Checking Docker...");
  await checkDocker();

  const openSandboxConfigChanged = await ensureServerConfig();
  await ensureServerDataDir();

  const state = await getContainerState(OPENSANDBOX_CONTAINER_NAME);

  if (state === "running") {
    if (openSandboxConfigChanged) {
      log.push("OpenSandbox networking config changed — restarting to apply it...");
      await restartContainer(OPENSANDBOX_CONTAINER_NAME);
      log.push("Waiting for OpenSandbox to be ready...");
      await pollHealth(`${SERVER_URL}/health`);
    } else {
      log.push(`OpenSandbox already running at ${SERVER_URL}`);
    }
  } else if (state === "stopped") {
    log.push("Restarting OpenSandbox container...");
    await startContainer(OPENSANDBOX_CONTAINER_NAME);
    log.push("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  } else {
    log.push("Starting OpenSandbox in Docker...");

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
    log.push("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  }

  await ensureAlineod(log, openSandboxConfigChanged);
  await ensureProjectConfig(log);
  log.push(`OpenSandbox running at ${SERVER_URL}, alineod running at ${ALINEOD_URL} — ready.`);

  return { log, serverUrl: SERVER_URL, alineodUrl: ALINEOD_URL };
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
async function ensureAlineod(log: string[], openSandboxConfigChanged: boolean): Promise<void> {
  const state = await getContainerState(ALINEOD_CONTAINER_NAME);

  if (state !== "missing" && openSandboxConfigChanged) {
    log.push("OpenSandbox networking config changed — recreating alineod to match...");
    await removeContainer(ALINEOD_CONTAINER_NAME);
  } else if (state === "running") {
    if (await isReachable(`${ALINEOD_URL}/health`, isAlineodHealthy)) {
      log.push(`alineod already running at ${ALINEOD_URL}`);
      return;
    }
    // Docker reports "running", but nothing answers — most often the exact Windows/Mac
    // `--network host` failure mode this split exists to avoid on a fresh init, or a container
    // left over from before this fix. Recreating (not just restarting) is what actually changes
    // its network mode — `docker restart` reapplies the same args the container already has.
    log.push("alineod is running but not reachable — recreating it...");
    await removeContainer(ALINEOD_CONTAINER_NAME);
  } else if (state === "stopped") {
    log.push("Restarting alineod container...");
    await startContainer(ALINEOD_CONTAINER_NAME);
    log.push("Waiting for alineod to be ready...");
    await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
    return;
  }

  log.push(`Pulling ${ALINEOD_IMAGE}...`);
  await pullImage(ALINEOD_IMAGE);
  log.push("Starting alineod in Docker...");

  const foundModelKeys = PI_MODEL_API_KEY_ENV_VARS.filter((name) => process.env[name]);
  const modelKeyArgs = foundModelKeys.flatMap((name) => ["-e", `${name}=${process.env[name]}`]);
  if (foundModelKeys.length > 0) {
    log.push(`Forwarding model key(s): ${foundModelKeys.join(", ")}`);
  } else {
    log.push(
      "No known model API key found in the environment — alineod will start, but agent " +
        "specs referencing a provider key will fail until one is set.",
    );
  }

  const networkArgs = usesHostNetworking
    ? ["--network", "host"]
    : ["-p", "4600:4600", "--add-host", "host.docker.internal:host-gateway"];
  const alineodServerUrl = usesHostNetworking ? SERVER_URL : "http://host.docker.internal:8080";

  await runContainer(
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

  log.push("Waiting for alineod to be ready...");
  await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
}

/** Writes `server.toml` if missing or if its `eip` doesn't match what this platform needs (see
 * `ensureAlineod`'s doc comment) — returns whether it changed, so callers can restart whatever
 * already-running containers depend on it. */
async function ensureServerConfig(): Promise<boolean> {
  const dir = serverConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const path = serverConfigPath();
  const eip = usesHostNetworking ? SERVER_URL : "http://host.docker.internal:8080";
  const desired = serverConfigContent(eip);
  const existing = existsSync(path) ? await Bun.file(path).text() : null;
  if (existing === desired) return false;
  await Bun.write(path, desired);
  return true;
}

async function ensureServerDataDir(): Promise<void> {
  const dir = serverDataDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function ensureProjectConfig(log: string[]): Promise<void> {
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
    log.push("Created alineo.config.json");
  }
}
