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

/**
 * What an on-disk `alineo.config.json` might actually contain — unlike `Partial<AlineoConfig>`,
 * every field is optional at every level, since the file is hand-editable and JSON.parse gives no
 * structural guarantee. A hand-edit like `{"defaults": {}}` or an interrupted `writeConfig` is a
 * realistic partial shape, not just a missing top-level field.
 */
type RawAlineoConfig = {
  [K in keyof AlineoConfig]?: K extends "defaults"
    ? { resources?: Partial<AlineoConfig["defaults"]["resources"]> }
    : AlineoConfig[K];
};

function fillDefaults(data: RawAlineoConfig): AlineoConfig {
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

/** Resolves, in order: a project-local `alineo.config.json`, then a global `~/.config/alineo/config.json`. */
export async function readConfig(): Promise<AlineoConfig> {
  const localFile = Bun.file(configPath());
  if (await localFile.exists()) {
    return fillDefaults((await localFile.json()) as RawAlineoConfig);
  }

  const globalPath = globalConfigPath();
  const globalFile = Bun.file(globalPath);
  if (await globalFile.exists()) {
    return fillDefaults((await globalFile.json()) as RawAlineoConfig);
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
 * Host directory bind-mounted into the OpenSandbox container at `/data` (see `init.ts`), backing
 * the `[store].path` set below. OpenSandbox itself persists snapshot metadata durably (a SQLite
 * db, meant to survive the server process restarting), but that guarantee is only as good as
 * where the db file actually lives: without this mount, it sits in the `alineo-opensandbox`
 * container's own writable layer, so restart is fine but any time the container itself is
 * recreated (host reboot with no restart policy, `docker system prune`, a stray `docker rm`)
 * silently loses every cached snapshot record — every `Alineo.load()` snapshot fast path pays a
 * full cold rebuild next time, indistinguishable from a genuinely changed spec (see issue #20).
 * Bind-mounting this directory makes that data outlive the container's own lifecycle, matching
 * OpenSandbox's own intent.
 */
export function serverDataDir(): string {
  return join(serverConfigDir(), "opensandbox-data");
}

/**
 * `egress.image`/`egress.mode` are configured unconditionally, not opt-in. Per OpenSandbox's own
 * control flow, a configured `egress.image` is inert for any sandbox created without a
 * `networkPolicy` — no sidecar is attached, no behavior changes for anyone not touching
 * `SandboxOptions.networkPolicy`/`credentialProxy`. Without this block, a fresh `alineo init`
 * server rejects any `networkPolicy`/`credentialProxy` request outright with "egress.image must
 * be configured" — this is what closes that gap (see issue #203). `dns+nft` (rather than `dns`)
 * is required for `credentialProxy`'s Credential Vault to activate at all.
 */
export function serverConfigContent(eip: string): string {
  return `[server]
host = "0.0.0.0"
port = 8080
eip = "${eip}"

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
