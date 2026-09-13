import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import {
  checkDocker,
  getContainerState,
  startContainer,
  runContainer,
  pullImage,
  pollHealth,
} from "../docker.js";
import {
  configPath,
  writeConfig,
  serverConfigDir,
  serverConfigPath,
  serverConfigContent,
  serverDataDir,
} from "../config.js";
import type { CliCommand } from "./types.js";
import { PI_MODEL_API_KEY_ENV_VARS } from "../pi-model-keys.js";

const OPENSANDBOX_CONTAINER_NAME = "alineo-opensandbox";
// 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first,
// and OpenSandbox only listens on IPv4.
const SERVER_URL = "http://127.0.0.1:8080";

const ALINEOD_CONTAINER_NAME = "alineo-alineod";
const ALINEOD_IMAGE = "ghcr.io/drejt/alineod:latest";
const ALINEOD_URL = "http://127.0.0.1:4600";
const isAlineodHealthy = (body: unknown): boolean => (body as { ok?: boolean } | null)?.ok === true;

export async function init(): Promise<void> {
  console.log("Checking Docker...");
  await checkDocker();

  const state = await getContainerState(OPENSANDBOX_CONTAINER_NAME);

  if (state === "running") {
    console.log(`OpenSandbox already running at ${SERVER_URL}`);
  } else if (state === "stopped") {
    console.log("Restarting OpenSandbox container...");
    await startContainer(OPENSANDBOX_CONTAINER_NAME);
    console.log("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  } else {
    await ensureServerConfig();
    await ensureServerDataDir();
    console.log("Starting OpenSandbox in Docker...");

    const dockerSocketMount = "/var/run/docker.sock:/var/run/docker.sock";

    await runContainer(
      [
        "-d",
        "--name",
        OPENSANDBOX_CONTAINER_NAME,
        "-p",
        "8080:8080",
        "-v",
        dockerSocketMount,
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
    console.log("Waiting for OpenSandbox to be ready...");
    await pollHealth(`${SERVER_URL}/health`);
  }

  await ensureAlineod();
  await ensureProjectConfig();
  console.log(`OpenSandbox running at ${SERVER_URL}, alineod running at ${ALINEOD_URL} — ready.`);
}

async function ensureAlineod(): Promise<void> {
  const state = await getContainerState(ALINEOD_CONTAINER_NAME);

  if (state === "running") {
    console.log(`alineod already running at ${ALINEOD_URL}`);
    return;
  }

  if (state === "stopped") {
    console.log("Restarting alineod container...");
    await startContainer(ALINEOD_CONTAINER_NAME);
  } else {
    console.log(`Pulling ${ALINEOD_IMAGE}...`);
    await pullImage(ALINEOD_IMAGE);
    console.log("Starting alineod in Docker...");

    // Model-agnostic: forward whatever Pi-supported provider key(s) are already in the
    // operator's shell. An AgentSpec's env map (e.g. `{ NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }`)
    // is resolved from process.env inside whichever process calls Alineo.load()/.spawn() —
    // for a swarm run through alineod, that's this container — so any provider works as long
    // as Pi supports it, not just NVIDIA's free tier.
    const foundModelKeys = PI_MODEL_API_KEY_ENV_VARS.filter((name) => process.env[name]);
    const modelKeyArgs = foundModelKeys.flatMap((name) => ["-e", `${name}=${process.env[name]}`]);
    if (foundModelKeys.length > 0) {
      console.log(`Forwarding model key(s): ${foundModelKeys.join(", ")}`);
    } else {
      console.log(
        "No known model API key found in the environment — alineod will start, but agent " +
          "specs referencing a provider key will fail until one is set (see any of the env " +
          "vars in packages/cli/src/pi-model-keys.ts).",
      );
    }

    await runContainer(
      [
        "-d",
        "--name",
        ALINEOD_CONTAINER_NAME,
        // Host networking, not a port mapping: OpenSandbox hands back sandbox proxy URLs
        // built from its own configured `eip` (127.0.0.1:8080, written by
        // ensureServerConfig() above) — a bridge-network container can't reach that
        // address. Host networking makes alineod see the host exactly like a bare
        // `bun run start` would (see apps/alineod/README.md's networking caveat).
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

  console.log("Waiting for alineod to be ready...");
  await pollHealth(`${ALINEOD_URL}/health`, 60_000, isAlineodHealthy);
}

async function ensureServerConfig(): Promise<void> {
  const dir = serverConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const path = serverConfigPath();
  if (!existsSync(path)) await Bun.write(path, serverConfigContent());
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

async function ensureProjectConfig(): Promise<void> {
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
    console.log("Created alineo.config.json");
  }
}

export const initCommand: CliCommand = {
  name: "init",
  group: "sdk",
  variants: [{ usage: "alineo init", summary: "Start OpenSandbox and alineod locally via Docker" }],
  run: async () => {
    await init();
  },
};
