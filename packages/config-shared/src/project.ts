import { z } from "zod";
import { loadConfig, loadConfigWithSources } from "./load";
import type { LoadedConfig } from "./load";

/**
 * The shape of `alineo.config.json` moved to `@alineo-labs/schema` — shapes with no behaviour
 * belong there, and it is published, so someone writing the file by hand can get the type from
 * the same place the tooling does. Re-exported here so every existing import keeps working.
 *
 * What stays in this file is the mechanism: reading the environment, and loading the file
 * through `loadConfig`'s precedence chain.
 */
export {
  PROJECT_CONFIG_SCHEMA_URL,
  ProjectConfigObjectSchema,
  ProjectConfigSchema,
} from "@alineo-labs/schema";
export type { ProjectConfig } from "@alineo-labs/schema";
import { ProjectConfigSchema } from "@alineo-labs/schema";
import type { ProjectConfig } from "@alineo-labs/schema";

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
