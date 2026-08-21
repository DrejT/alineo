import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export interface AlineoConfig {
  serverUrl: string;
  useServerProxy: boolean;
  apiKey: string;
  adapterPath: string;
  agentsDir: string;
  defaults: {
    resources: { cpu: string; memory: string };
  };
}

const CONFIG_DIR = ".alineo";
const CONFIG_FILE = "alineo.config.json";

export function configPath(): string {
  return CONFIG_FILE;
}

export function globalConfigPath(): string {
  return join(serverConfigDir(), "config.json");
}

function fillDefaults(data: Partial<AlineoConfig>): AlineoConfig {
  return {
    serverUrl: data.serverUrl ?? "http://127.0.0.1:8080",
    useServerProxy: data.useServerProxy ?? true,
    apiKey: data.apiKey ?? "",
    adapterPath: data.adapterPath ?? "./.alineo/ledger.db",
    agentsDir: data.agentsDir ?? "./agents",
    defaults: {
      resources: {
        cpu: data.defaults?.resources?.cpu ?? "1000m",
        memory: data.defaults?.resources?.memory ?? "1Gi",
      },
    },
  };
}

/**
 * Resolves, in order: a project-local `alineo.config.json` (written by `alineo init`
 * for repos that want their own agents dir / ledger), then a global
 * `~/.config/alineo/config.json`. If neither exists yet, bootstraps the global
 * one so a fresh `bunx alineo-cli` works without requiring `init` in every directory.
 */
export async function readConfig(): Promise<AlineoConfig> {
  const localFile = Bun.file(configPath());
  if (await localFile.exists()) {
    return fillDefaults((await localFile.json()) as Partial<AlineoConfig>);
  }

  const globalPath = globalConfigPath();
  const globalFile = Bun.file(globalPath);
  if (await globalFile.exists()) {
    return fillDefaults((await globalFile.json()) as Partial<AlineoConfig>);
  }

  const dir = serverConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const config: AlineoConfig = {
    serverUrl: "http://127.0.0.1:8080",
    useServerProxy: true,
    apiKey: "",
    adapterPath: join(dir, "ledger.db"),
    agentsDir: join(dir, "agents"),
    defaults: { resources: { cpu: "1000m", memory: "1Gi" } },
  };
  await Bun.write(globalPath, JSON.stringify(config, null, 2) + "\n");
  return config;
}

export async function writeConfig(config: AlineoConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export function serverConfigDir(): string {
  return join(homedir(), ".config", "alineo");
}

export function serverConfigPath(): string {
  return join(serverConfigDir(), "server.toml");
}

/**
 * Host directory bind-mounted into the OpenSandbox container at `/data` (see
 * `commands/init.ts`), backing the `[store].path` set below. OpenSandbox itself persists
 * snapshot metadata durably (a SQLite db, meant to survive the server process restarting —
 * see opensandbox-group/OpenSandbox's `PersistedSnapshotService`), but that guarantee is
 * only as good as where the db file actually lives: without this mount, it sits in the
 * `alineo-opensandbox` container's own writable layer, so restart is fine but any time the
 * container itself is recreated (host reboot with no restart policy, `docker system prune`,
 * a stray `docker rm`) silently loses every cached snapshot record — every `Alineo.load()`
 * snapshot fast path pays a full cold rebuild next time, indistinguishable from a genuinely
 * changed spec (see issue #20). Bind-mounting this directory makes that data outlive the
 * container's own lifecycle, matching OpenSandbox's own intent.
 */
export function serverDataDir(): string {
  return join(serverConfigDir(), "opensandbox-data");
}

/**
 * v1.0.19 (the previous pin) predates cached bwrap-archive support, so every sandbox logged
 * "bwrap archive not cached for linux/amd64 -- isolation will be unavailable" and isolation
 * sessions (and anything that depends on them, e.g. pause()/resume()) hung indefinitely
 * instead of failing cleanly. OpenSandbox's own docs: >=v1.0.20 has base isolation-session
 * support, >=v1.0.21 is recommended for full functionality -- the "v1.1.0+" the warning
 * message itself suggests does not exist as a published tag. v1.0.22 is the latest.
 */
export function serverConfigContent(): string {
  return `[server]
host = "0.0.0.0"
port = 8080
eip = "http://127.0.0.1:8080"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.22"

[docker]
network_mode = "bridge"

[store]
type = "sqlite"
path = "/data/opensandbox.db"
`;
}
