export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Silent = 4,
}

// `meta?: Record<string, unknown>` throughout this file (anti-slop/no-unsafe-dictionary-type is
// off, see .oxlintrc.json): structured logging metadata is open-ended by design, same
// convention as pino/winston/console -- there's no fixed schema to derive a value type from.
export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

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
