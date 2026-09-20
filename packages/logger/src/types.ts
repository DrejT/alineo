/** Severity names, lowest to highest. */
export type LevelName = "debug" | "info" | "warn" | "error";

/** A threshold: a level name (that level and above pass), or `silent` to drop everything. */
export type LevelSetting = LevelName | "silent";

export type LogFields = Readonly<Record<string, unknown>>;

export type LogFormat = "pretty" | "json";

/** One log line, before formatting. Sinks receive these. */
export interface LogRecord {
  readonly ts: number;
  readonly level: LevelName;
  /** Which part of alineo emitted it: `agent`, `alineod`, `sandbox`, … */
  readonly component: string;
  readonly msg: string;
  /** Bound (`child`) fields merged with the call's own fields. */
  readonly fields: LogFields;
}

/** Where records go. Must not throw (a throwing sink is swallowed, never propagated to the caller). */
export type LogSink = (record: LogRecord) => void;

/** The original alineo logger shape, kept so existing `ILogger` implementations still type-check. */
export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface Logger extends ILogger {
  /** A logger that adds `fields` to every record it emits (e.g. `{ runId, agentId }`). */
  child(fields: LogFields): Logger;
  /** Cheap check for skipping expensive field construction. */
  isEnabled(level: LevelName): boolean;
}
