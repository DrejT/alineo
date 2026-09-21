import { z } from "zod";
import { loadConfig, loadConfigWithSources } from "./load";
import type { LoadedConfig } from "./load";

/**
 * The shape of `alineo.config.json`.
 *
 * It lives here, with the mechanism, rather than in one consuming package because three
 * consumers read the same file — `packages/agent`, `packages/cli-shared` and (through the
 * Docker entrypoint) `apps/alineod`. Putting it in any one of them would force the other two
 * to depend on that package for a file none of them owns. Settings specific to a single
 * consumer — alineod's timeouts, for example — stay with that consumer and use
 * `defineEnv`/`loadConfig` directly.
 */
const ProjectConfigObject = z.object({
  /**
   * 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first, and OpenSandbox
   * typically only listens on IPv4.
   */
  serverUrl: z.string().min(1).default("http://127.0.0.1:8080"),
  /** OpenSandbox API key. Empty string for local dev with no auth. */
  apiKey: z.string().default(""),
  /**
   * Route execd and proxy traffic through the OpenSandbox server. Required when the server runs
   * in Docker (e.g. started by `alineo init`).
   */
  useServerProxy: z.boolean().default(true),
  /**
   * Anchor path used to derive the agent snapshot store location (`agent-snapshots.json` is
   * written next to it). Does not select the ledger storage adapter.
   */
  adapterPath: z.string().min(1).default("./.alineo/ledger.db"),
  /** Directory holding agent spec files. */
  agentsDir: z.string().min(1).default("./agents"),
  /**
   * Applied when an agent spec omits the field.
   *
   * `.prefault({})` rather than `.default({})`: Zod 4 uses a `default` value as-is, so
   * `.default({})` on a nested object would yield a literal `{}` and leave `cpu`/`memory`
   * undefined. `prefault` parses the value through the schema, which fills the inner defaults.
   */
  defaults: z
    .object({
      resources: z
        .object({
          cpu: z.string().min(1).default("1000m"),
          memory: z.string().min(1).default("1Gi"),
        })
        .prefault({}),
    })
    .prefault({}),
});

/**
 * In this file `null` means "not set", exactly as the hand-written reader's `??` chain used to
 * treat it. The file is hand-editable, an interrupted write can leave `{"defaults": {"resources":
 * null}}` behind, and no field here has a meaningful null value — so a stray null falls back to
 * the built-in default instead of failing validation and taking the CLI or the daemon down.
 */
function dropNulls(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null) continue;
    out[key] = dropNulls(inner);
  }
  return out;
}

/** The project config schema, with nulls treated as absent. */
export const ProjectConfigSchema = z.preprocess(dropNulls, ProjectConfigObject);

/** The underlying object schema, for JSON Schema emit (preprocess has no JSON Schema form). */
export const ProjectConfigObjectSchema = ProjectConfigObject;

export type ProjectConfig = z.infer<typeof ProjectConfigObject>;

/** `$schema` URL written into a generated `alineo.config.json`. */
export const PROJECT_CONFIG_SCHEMA_URL = "https://alineo.tech/schema/alineo.config.json";

function parseBoolean(raw: string, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`${name}=${JSON.stringify(raw)} is not a boolean (use true or false)`);
}

/**
 * Project-config fields settable from the environment. These are what
 * `apps/alineod/docker-entrypoint.sh` writes into a generated config file before starting the
 * server; reading them directly means the container no longer has to write a file at all.
 */
export function projectConfigFromEnv(
  env: Record<string, string | undefined>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (env.ALINEO_SERVER_URL !== undefined) out.serverUrl = env.ALINEO_SERVER_URL;
  if (env.ALINEO_API_KEY !== undefined) out.apiKey = env.ALINEO_API_KEY;
  if (env.ALINEO_USE_SERVER_PROXY !== undefined) {
    out.useServerProxy = parseBoolean(env.ALINEO_USE_SERVER_PROXY, "ALINEO_USE_SERVER_PROXY");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface LoadProjectConfigOptions {
  /** Where the walk-up starts. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Highest precedence. */
  overrides?: Partial<ProjectConfig>;
  /** Pass `null` to skip `~/.config/alineo/config.json`. */
  globalPath?: string | null;
  /** `false` validates `overrides` alone — no files, no env. */
  discover?: boolean;
  onWarning?: (message: string) => void;
}

/** Resolve `alineo.config.json` from every source. Validated once, then frozen. */
export function loadProjectConfig(options: LoadProjectConfigOptions = {}): ProjectConfig {
  return loadConfig({
    schema: ProjectConfigSchema,
    fromEnv: projectConfigFromEnv,
    label: "alineo config",
    ...options,
  });
}

/** `loadProjectConfig` plus which sources actually contributed. */
export function loadProjectConfigWithSources(
  options: LoadProjectConfigOptions = {},
): LoadedConfig<ProjectConfig> {
  return loadConfigWithSources({
    schema: ProjectConfigSchema,
    fromEnv: projectConfigFromEnv,
    label: "alineo config",
    ...options,
  });
}
