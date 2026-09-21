import type { ZodType } from "zod";
import { findProjectConfig, globalConfigPath, readJsonFile } from "./discover";
import { deepFreeze, mergeDeep } from "./merge";

/** Env var holding a whole config document inline, as JSON. */
export const CONFIG_CONTENT_ENV = "ALINEO_CONFIG_CONTENT";

export interface LoadConfigOptions<T> {
  /** Validates the merged result. Schema defaults supply the lowest precedence layer. */
  schema: ZodType<T>;
  /** Where the project-file walk-up starts. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Projects env vars into config shape. Return `undefined` for "nothing set". */
  fromEnv?: (env: Record<string, string | undefined>) => unknown;
  /** Highest precedence — flags, or an explicit object from an embedded caller. */
  overrides?: unknown;
  /** User-level config. Pass `null` to skip it. Defaults to `~/.config/alineo/config.json`. */
  globalPath?: string | null;
  /**
   * When `false`, no file or env source is consulted and only `overrides` is validated.
   * This is how a server or a test gets a fully explicit config with no ambient input.
   */
  discover?: boolean;
  /** Called for deprecated aliases and other non-fatal notes. */
  onWarning?: (message: string) => void;
  /** Names the config in error messages. Defaults to `"config"`. */
  label?: string;
}

/** Everything that fed one resolved config, in the order it was applied. */
export interface ConfigSources {
  globalFile: string | null;
  projectFile: string | null;
  inlineEnv: boolean;
  envVars: boolean;
  overrides: boolean;
}

export interface LoadedConfig<T> {
  config: T;
  sources: ConfigSources;
}

/**
 * Resolve configuration from every source, lowest precedence first:
 *
 * ```
 * schema defaults
 *   < ~/.config/alineo/config.json      (user)
 *   < alineo.config.json                (project — found by bounded walk-up)
 *   < ALINEO_CONFIG_CONTENT             (inline JSON)
 *   < ALINEO_* env vars                 (ops)
 *   < overrides                         (flags / explicit call-site object)
 * ```
 *
 * Validated once, then deep-frozen. **This function is pure with respect to module state** —
 * nothing is cached here and there is no installed singleton, so two bundled copies of this
 * package cannot drift apart. Callers hold the result for as long as they need it.
 */
export function loadConfigWithSources<T>(options: LoadConfigOptions<T>): LoadedConfig<T> {
  const {
    schema,
    cwd = process.cwd(),
    env = process.env as Record<string, string | undefined>,
    fromEnv,
    overrides,
    globalPath = globalConfigPath(),
    discover = true,
    label = "config",
  } = options;

  const sources: ConfigSources = {
    globalFile: null,
    projectFile: null,
    inlineEnv: false,
    envVars: false,
    overrides: overrides !== undefined,
  };

  const layers: unknown[] = [];

  if (discover) {
    if (globalPath) {
      const globalData = readJsonFile(globalPath);
      if (globalData !== null) {
        layers.push(globalData);
        sources.globalFile = globalPath;
      }
    }

    const projectFile = findProjectConfig(cwd);
    if (projectFile) {
      const projectData = readJsonFile(projectFile);
      if (projectData !== null) {
        layers.push(projectData);
        sources.projectFile = projectFile;
      }
    }

    const inline = env[CONFIG_CONTENT_ENV];
    if (inline !== undefined && inline.trim() !== "") {
      try {
        layers.push(JSON.parse(inline) as unknown);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${CONFIG_CONTENT_ENV} is not valid JSON: ${message}`);
      }
      sources.inlineEnv = true;
    }

    if (fromEnv) {
      const fromEnvData = fromEnv(env);
      if (fromEnvData !== undefined) {
        layers.push(fromEnvData);
        sources.envVars = true;
      }
    }
  }

  if (overrides !== undefined) layers.push(overrides);

  const merged = layers.length > 0 ? mergeDeep(...layers) : {};
  const parsed = schema.safeParse(merged ?? {});

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `  ${path}: ${issue.message}`;
      })
      .join("\n");
    const from = describeSources(sources);
    throw new Error(`Invalid ${label}${from}:\n${details}`);
  }

  return { config: deepFreeze(parsed.data), sources };
}

/** `loadConfigWithSources` without the provenance — the common case. */
export function loadConfig<T>(options: LoadConfigOptions<T>): T {
  return loadConfigWithSources(options).config;
}

function describeSources(sources: ConfigSources): string {
  const parts: string[] = [];
  if (sources.globalFile) parts.push(sources.globalFile);
  if (sources.projectFile) parts.push(sources.projectFile);
  if (sources.inlineEnv) parts.push(CONFIG_CONTENT_ENV);
  if (sources.envVars) parts.push("environment");
  if (sources.overrides) parts.push("explicit options");
  return parts.length > 0 ? ` (from ${parts.join(", ")})` : "";
}
