import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import os from "os";
import {
  checkDocker,
  getContainerState,
  startContainer,
  runContainer,
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

const CONTAINER_NAME = "alineo-opensandbox";
// 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first,
// and OpenSandbox only listens on IPv4.
const SERVER_URL = "http://127.0.0.1:8080";

export async function init(): Promise<void> {
  console.log("Checking Docker...");
  await checkDocker();

  const state = await getContainerState(CONTAINER_NAME);

  if (state === "running") {
    console.log(`OpenSandbox already running at ${SERVER_URL}`);
    await ensureProjectConfig();
    return;
  }

  if (state === "stopped") {
    console.log("Restarting OpenSandbox container...");
    await startContainer(CONTAINER_NAME);
  } else {
    await ensureServerConfig();
    await ensureServerDataDir();
    console.log("Starting OpenSandbox in Docker...");

    const isWindows = os.platform() === "win32";
    const dockerSocketMount = isWindows
      ? "//./pipe/docker_engine://./pipe/docker_engine"
      : "/var/run/docker.sock:/var/run/docker.sock";

    await runContainer([
      "-d",
      "--name",
      CONTAINER_NAME,
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
    ]);
  }

  console.log("Waiting for OpenSandbox to be ready...");
  await pollHealth(`${SERVER_URL}/health`);
  await ensureProjectConfig();
  console.log(`OpenSandbox running at ${SERVER_URL} — ready.`);
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
  variants: [{ usage: "alineo init", summary: "Start OpenSandbox locally via Docker" }],
  run: async () => {
    await init();
  },
};
