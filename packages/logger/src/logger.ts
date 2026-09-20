import { readEnvConfig } from "./env";
import type { Env, EnvLogConfig } from "./env";
import { meets } from "./levels";
import { defaultFormat, fileSink, stderrSink } from "./sinks";
import type { LevelName, LevelSetting, LogFields, LogSink, Logger } from "./types";

/**
 * Process-wide configuration. It lives on `globalThis` (not in module scope) so that several
 * copies of this package in one process — a published package nested under another, a bundled
 * duplicate — still share a single switch. Same reason OpenTelemetry's `diag` registers globally.
 */
interface State {
  /** An explicit install (or an env-driven one) has happened. */
  configured: boolean;
  /** The lazy env check has run. */
  envChecked: boolean;
  level: LevelSetting;
  components: Map<string, LevelSetting>;
  sink: LogSink | null;
  fields: LogFields;
}

declare global {
  var __ALINEO_LOGGER__: State | undefined;
}

function fresh(): State {
  return {
    configured: false,
    envChecked: false,
    level: "silent",
    components: new Map(),
    sink: null,
    fields: {},
  };
}

function state(): State {
  let s = globalThis.__ALINEO_LOGGER__;
  if (!s) {
    s = fresh();
    globalThis.__ALINEO_LOGGER__ = s;
  }
  return s;
}

function processEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}

function thresholdFor(s: State, component: string): LevelSetting {
  return s.components.get(component) ?? s.components.get("*") ?? s.level;
}

/**
 * Library-safe default: nothing is logged until an app installs a logger — *or* the environment
 * asks for it (`ALINEO_LOG_LEVEL=info bun script.ts` needs no code). Checked once, lazily, so
 * loggers created at import time still work.
 */
function ensureEnv(s: State): void {
  if (s.configured || s.envChecked) return;
  s.envChecked = true;
  const config = readEnvConfig(processEnv());
  if (config?.requested) applyEnv(config, undefined);
}

function build(component: string, bound: LogFields): Logger {
  const emit = (level: LevelName, msg: string, fields?: Record<string, unknown>): void => {
    const s = state();
    ensureEnv(s);
    if (s.sink === null || !meets(level, thresholdFor(s, component))) return;
    try {
      s.sink({
        ts: Date.now(),
        level,
        component,
        msg,
        fields: { ...s.fields, ...bound, ...fields },
      });
    } catch {
      // logging must never break the code that logged
    }
  };
  return {
    debug: (msg, fields) => {
      emit("debug", msg, fields);
    },
    info: (msg, fields) => {
      emit("info", msg, fields);
    },
    warn: (msg, fields) => {
      emit("warn", msg, fields);
    },
    error: (msg, fields) => {
      emit("error", msg, fields);
    },
    child: (fields) => build(component, { ...bound, ...fields }),
    isEnabled: (level) => {
      const s = state();
      ensureEnv(s);
      return s.sink !== null && meets(level, thresholdFor(s, component));
    },
  };
}

/**
 * A logger for one component (`agent`, `alineod`, …). Safe to call at module load: it reads the
 * current configuration on every call, so it works whether the app installs a logger before or
 * after. Silent until something turns logging on.
 */
export function getLogger(component: string): Logger {
  return build(component, {});
}

export interface InstallOptions {
  /** Default threshold. Default: `info`. */
  level?: LevelSetting;
  /** Per-component overrides; `"*"` sets the default. */
  components?: Record<string, LevelSetting>;
  /** Where records go. Default: stderr (`pretty` on a TTY, `json` otherwise). */
  sink?: LogSink;
  /** Fields added to every record. */
  fields?: LogFields;
}

/** Turns logging on for this process. Last call wins; safe before or after `getLogger`. */
export function installLogger(options: InstallOptions = {}): void {
  const s = state();
  s.configured = true;
  s.envChecked = true;
  s.level = options.level ?? "info";
  s.components = new Map(Object.entries(options.components ?? {}));
  s.sink = options.sink ?? stderrSink();
  s.fields = options.fields ?? {};
}

export interface EnvInstallOptions {
  /** Level when the environment doesn't set one. Apps pass `"info"`; libraries never call this. */
  defaultLevel?: LevelSetting;
  /** Environment to read (default `process.env`). */
  env?: Env;
  /** Override the sink (default: stderr, or `ALINEO_LOG_FILE`). */
  sink?: LogSink;
}

function applyEnv(config: EnvLogConfig | null, options: EnvInstallOptions | undefined): void {
  const level = config?.level ?? options?.defaultLevel ?? (config?.file ? "info" : "silent");

  let sink: LogSink | undefined = options?.sink;
  const problems = [...(config?.invalid ?? [])];
  if (!sink && config?.file) {
    try {
      sink = fileSink(config.file, config.format ?? "json");
    } catch (err) {
      problems.push(`ALINEO_LOG_FILE: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  sink ??= stderrSink(config?.format ?? defaultFormat());

  installLogger({ level, components: config?.components, sink });

  if (problems.length > 0) {
    getLogger("logger").warn("ignored invalid logging configuration", { problems });
  }
}

/**
 * For app entrypoints (CLI, daemons): turn logging on according to the environment.
 *
 * ```ts
 * installLoggerFromEnv({ defaultLevel: "info" }); // daemon: info unless ALINEO_LOG_LEVEL says otherwise
 * ```
 */
export function installLoggerFromEnv(options: EnvInstallOptions = {}): void {
  applyEnv(readEnvConfig(options.env ?? processEnv()), options);
}

/** Back to the silent default. For tests. */
export function resetLogger(): void {
  globalThis.__ALINEO_LOGGER__ = undefined;
}
