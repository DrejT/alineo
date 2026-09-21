import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import {
  findProjectConfig,
  loadProjectConfig,
  PROJECT_CONFIG_FILE,
  type ProjectConfig,
} from "@alineo-labs/config-shared";

/**
 * The `alineo.config.json` shape. Defined in `@alineo-labs/config-shared` because this package,
 * `packages/agent` and alineod's Docker entrypoint all read the same file.
 */
export type AlineoConfig = ProjectConfig;

const CONFIG_DIR = ".alineo";

export function configPath(): string {
  return PROJECT_CONFIG_FILE;
}

export function globalConfigPath(): string {
  return join(serverConfigDir(), "config.json");
}

/**
 * Resolve the CLI's configuration.
 *
 * Sources are merged lowest-first — `~/.config/alineo/config.json`, then the nearest
 * `alineo.config.json` (found by walking up from the working directory), then `ALINEO_*`
 * environment variables. Two things changed when this moved onto `@alineo-labs/config-shared`:
 * a project config is now found from a subdirectory rather than only from the exact working
 * directory, and a global config no longer disappears entirely just because a project config
 * exists — the project file overrides key by key.
 *
 * When neither file exists, the global one is bootstrapped so a fresh `bunx alineo-cli` works
 * without an `init` in every directory.
 */
export async function readConfig(): Promise<AlineoConfig> {
  const hasProject = findProjectConfig() !== null;
  const globalPath = globalConfigPath();

  if (!hasProject && !existsSync(globalPath)) {
    const dir = serverConfigDir();
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    // Paths point inside the config dir, so a CLI run from anywhere has somewhere to write.
    const bootstrapped = loadProjectConfig({
      discover: false,
      overrides: { adapterPath: join(dir, "ledger.db"), agentsDir: join(dir, "agents") },
    });
    await Bun.write(globalPath, JSON.stringify(bootstrapped, null, 2) + "\n");
    return bootstrapped;
  }

  return loadProjectConfig({ globalPath });
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
 * Host directory bind-mounted into the OpenSandbox container at `/data` (see `init.ts`),
 * backing the `[store].path` set below. OpenSandbox itself persists
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
/**
 * `egress.image`/`egress.mode` are configured unconditionally, not opt-in. Per OpenSandbox's
 * own control flow, a configured `egress.image` is inert for any sandbox created without a
 * `networkPolicy` — no sidecar is attached, no behavior changes for anyone not touching
 * `SandboxOptions.networkPolicy`/`credentialProxy`. Without this block, a fresh `alineo init`
 * server rejects any `networkPolicy`/`credentialProxy` request outright with
 * "egress.image must be configured" — this is what closes that gap (see issue #203,
 * plans/credential-injection.md Phase 4). `dns+nft` (rather than `dns`) is required for
 * `credentialProxy`'s Credential Vault to activate at all.
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
