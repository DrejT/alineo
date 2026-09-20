import type { ILogger } from "./types";

/**
 * The original `@alineo-labs/core` logger, moved here unchanged so the old exports keep working.
 * New code should use `getLogger()` — it is silent by default, has child loggers, and honours
 * `ALINEO_LOG_LEVEL`. This class always prints to the console.
 */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Silent = 4,
}

/** Legacy: always prints to the console. Prefer `getLogger()` + `installLogger()`. */
export class ConsoleLogger implements ILogger {
  constructor(private readonly minLevel: LogLevel = LogLevel.Info) {}

  private log(level: LogLevel, prefix: string, msg: string, meta?: Record<string, unknown>): void {
    if (level < this.minLevel) return;
    const out = meta ? `${prefix} ${msg} ${JSON.stringify(meta)}` : `${prefix} ${msg}`;
    if (level >= LogLevel.Error) console.error(out);
    else console.log(out);
  }

  debug(msg: string, meta?: Record<string, unknown>) {
    this.log(LogLevel.Debug, "[DEBUG]", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>) {
    this.log(LogLevel.Info, "[INFO]", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>) {
    this.log(LogLevel.Warn, "[WARN]", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>) {
    this.log(LogLevel.Error, "[ERROR]", msg, meta);
  }
}

export const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
