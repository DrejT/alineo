export type {
  ILogger,
  LevelName,
  LevelSetting,
  LogFields,
  LogFormat,
  LogRecord,
  LogSink,
  Logger,
} from "./types";

export { getLogger, installLogger, installLoggerFromEnv, resetLogger } from "./logger";
export type { EnvInstallOptions, InstallOptions } from "./logger";

export { parseLogSpec, readEnvConfig } from "./env";
export type { Env, EnvLogConfig, LogSpec } from "./env";

export { composeSinks, defaultFormat, fileSink, stderrSink } from "./sinks";
export { formatJson, formatPretty } from "./format";

// Moved from @alineo-labs/core (which still re-exports them).
export { ConsoleLogger, LogLevel, noopLogger } from "./compat";
