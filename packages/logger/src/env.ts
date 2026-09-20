import { parseLevel } from "./levels";
import { isLogFormat } from "./sinks";
import type { LevelSetting, LogFormat } from "./types";

export type Env = Readonly<Record<string, string | undefined>>;

export interface LogSpec {
  /** Bare level (`debug`) or `*=debug`. */
  level?: LevelSetting;
  /** `name=level` entries. */
  components: Record<string, LevelSetting>;
  /** Tokens that weren't a valid level or `name=level`. */
  invalid: string[];
}

/**
 * Parses `agent=debug,alineod=info,warn` — comma-separated `component=level` entries plus an
 * optional bare level (or `*=level`) that sets the default. Invalid tokens are reported, not thrown.
 */
export function parseLogSpec(spec: string): LogSpec {
  const out: LogSpec = { components: {}, invalid: [] };
  for (const raw of spec.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq === -1) {
      const level = parseLevel(token);
      if (level) out.level = level;
      else out.invalid.push(token);
      continue;
    }
    const name = token.slice(0, eq).trim();
    const level = parseLevel(token.slice(eq + 1));
    if (!name || !level) {
      out.invalid.push(token);
    } else if (name === "*") {
      out.level = level;
    } else {
      out.components[name] = level;
    }
  }
  return out;
}

export interface EnvLogConfig {
  level?: LevelSetting;
  components: Record<string, LevelSetting>;
  format?: LogFormat;
  file?: string;
  invalid: string[];
  /**
   * True when the environment asks for logging to be on (a level, `ALINEO_LOG` or a file is
   * set). `ALINEO_LOG_FORMAT` alone only shapes the output of a logger an app turns on.
   */
  requested: boolean;
}

/**
 * Reads the logging env vars:
 *
 * - `ALINEO_LOG_LEVEL` — default level (`debug|info|warn|error|silent`)
 * - `ALINEO_LOG` — per-component levels, e.g. `agent=debug,alineod=info` (wins over `ALINEO_LOG_LEVEL`)
 * - `ALINEO_LOG_FORMAT` — `pretty` | `json` (default: pretty on a TTY, json otherwise)
 * - `ALINEO_LOG_FILE` — write to this file instead of stderr
 *
 * Returns `null` when none of them is set. See `requested` for whether logging was asked for.
 */
export function readEnvConfig(env: Env): EnvLogConfig | null {
  const levelText = env.ALINEO_LOG_LEVEL?.trim();
  const specText = env.ALINEO_LOG?.trim();
  const file = env.ALINEO_LOG_FILE?.trim();
  const formatText = env.ALINEO_LOG_FORMAT?.trim().toLowerCase();
  if (!levelText && !specText && !file && !formatText) return null;

  const invalid: string[] = [];

  let level: LevelSetting | undefined;
  if (levelText) {
    level = parseLevel(levelText);
    if (!level) invalid.push(`ALINEO_LOG_LEVEL=${levelText}`);
  }

  const spec: LogSpec = specText ? parseLogSpec(specText) : { components: {}, invalid: [] };
  invalid.push(...spec.invalid.map((token) => `ALINEO_LOG:${token}`));

  const format = isLogFormat(formatText) ? formatText : undefined;
  if (formatText && !format) invalid.push(`ALINEO_LOG_FORMAT=${formatText}`);

  return {
    level: spec.level ?? level,
    components: spec.components,
    format,
    file: file === "" ? undefined : file,
    invalid,
    requested: Boolean(levelText || specText || file),
  };
}
