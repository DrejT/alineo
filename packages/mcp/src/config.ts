/**
 * Local project/global config — the same `alineo.config.json` shape and resolution order as
 * `alineo-cli` (`packages/cli/src/config.ts`), duplicated rather than imported: `alineo-cli`
 * only publishes its `bin`, not these internals, as a library entry point. Only the fields the
 * local spec-management and `alineo_init` tools need are used here; kept identical so a project
 * bootstrapped by either tool works with the other.
 */
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
        cpu: data.defaults?.resources.cpu ?? "1000m",
        memory: data.defaults?.resources.memory ?? "1Gi",
      },
    },
  };
}

/** Resolves, in order: a project-local `alineo.config.json`, then a global `~/.config/alineo/config.json`. */
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

export function serverDataDir(): string {
  return join(serverConfigDir(), "opensandbox-data");
}

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

[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns+nft"
`;
}
