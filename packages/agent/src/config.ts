import { existsSync } from "fs";

/** Shape of `alineo.config.json` in the project root, merged with built-in defaults. */
export interface AlineoAgentConfig {
  /** OpenSandbox server URL. Default: `http://127.0.0.1:8080`. */
  serverUrl: string;
  /** OpenSandbox API key. Pass an empty string for local dev with no auth. */
  apiKey: string;
  /**
   * Anchor path used to derive the agent snapshot store location
   * (`agent-snapshots.json` is written next to this path). Does not select
   * the ledger storage adapter — pass that directly via `Alineo.load`'s
   * `opts.adapter` / `Alineo.resume`'s `opts.adapter`.
   * Default: `./.alineo/ledger.db`.
   */
  adapterPath: string;
  /**
   * Route execd and proxy traffic through the OpenSandbox server.
   * Required when the server runs in Docker (e.g. started via `alineo init`).
   * Default: `true`.
   */
  useServerProxy: boolean;
  /** Directory containing agent spec files. Default: `./agents`. */
  agentsDir: string;
  /** Default values applied when an agent spec omits a field. */
  defaults: {
    resources: { cpu: string; memory: string };
  };
}

const CONFIG_FILE = "alineo.config.json";

const DEFAULT_CONFIG: AlineoAgentConfig = {
  // 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first,
  // and OpenSandbox typically only listens on IPv4.
  serverUrl: "http://127.0.0.1:8080",
  apiKey: "",
  adapterPath: "./.alineo/ledger.db",
  useServerProxy: true,
  agentsDir: "./agents",
  defaults: {
    resources: { cpu: "1000m", memory: "1Gi" },
  },
};

/**
 * Read `alineo.config.json` from the current working directory and merge it with
 * built-in defaults. Missing fields fall back to the defaults — the config file
 * is fully optional.
 */
export async function readProjectConfig(): Promise<AlineoAgentConfig> {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  const data = (await Bun.file(CONFIG_FILE).json()) as Partial<AlineoAgentConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...data,
    defaults: {
      ...DEFAULT_CONFIG.defaults,
      ...(data.defaults ?? {}),
      resources: {
        ...DEFAULT_CONFIG.defaults.resources,
        ...(data.defaults?.resources ?? {}),
      },
    },
  };
}
