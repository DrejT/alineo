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
  runContainer,
  pullImage,
  pollHealth,
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

export interface InitResult {
  log: string[];
  serverUrl: string;
  alineodUrl: string;
}

export async function init(): Promise<InitResult> {
  const log: string[] = [];
  log.push("Checking Docker...");
  await checkDocker();

  const state = await getContainerState(OPENSANDBOX_CONTAINER_NAME);

  if (state === "running") {
    log.push(`OpenSandbox already running at ${SERVER_URL}`);
  } else if (state === "stopped") {
    log.push("Restarting OpenSandbox container...");
    await startContainer(OPENSANDBOX_CONTAINER_NAME);
    log.push("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  } else {
    await ensureServerConfig();
    await ensureServerDataDir();
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

  await ensureAlineod(log);
  await ensureProjectConfig(log);
  log.push(`OpenSandbox running at ${SERVER_URL}, alineod running at ${ALINEOD_URL} — ready.`);

  return { log, serverUrl: SERVER_URL, alineodUrl: ALINEOD_URL };
}

async function ensureAlineod(log: string[]): Promise<void> {
  const state = await getContainerState(ALINEOD_CONTAINER_NAME);

  if (state === "running") {
    log.push(`alineod already running at ${ALINEOD_URL}`);
    return;
  }

  if (state === "stopped") {
    log.push("Restarting alineod container...");
    await startContainer(ALINEOD_CONTAINER_NAME);
  } else {
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

    await runContainer(
      [
        "-d",
        "--name",
        ALINEOD_CONTAINER_NAME,
        "--network",
        "host",
        "-e",
        `ALINEO_SERVER_URL=${SERVER_URL}`,
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

  log.push("Waiting for alineod to be ready...");
  await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
}

async function ensureServerConfig(): Promise<void> {
  const dir = serverConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const path = serverConfigPath();
  if (!existsSync(path)) await Bun.write(path, serverConfigContent());
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
