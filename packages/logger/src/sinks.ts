import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatJson, formatPretty } from "./format";
import type { LogFormat, LogRecord, LogSink } from "./types";

export function isLogFormat(value: unknown): value is LogFormat {
  return value === "pretty" || value === "json";
}

/** `pretty` on an interactive terminal, `json` lines everywhere else (pipes, Docker, journald). */
export function defaultFormat(): LogFormat {
  return typeof process !== "undefined" && process.stderr.isTTY === true ? "pretty" : "json";
}

function formatterFor(format: LogFormat): (record: LogRecord) => string {
  return format === "json" ? formatJson : formatPretty;
}

/** Writes one line per record to **stderr** — never stdout, which belongs to program output (and to MCP's JSON-RPC). */
export function stderrSink(format: LogFormat = defaultFormat()): LogSink {
  const fmt = formatterFor(format);
  return (record) => {
    process.stderr.write(`${fmt(record)}\n`);
  };
}

/** Appends one line per record to `path` (parent directories are created). */
export function fileSink(path: string, format: LogFormat = "json"): LogSink {
  const fmt = formatterFor(format);
  mkdirSync(dirname(path), { recursive: true });
  return (record) => {
    appendFileSync(path, `${fmt(record)}\n`);
  };
}

/** Fans a record out to every sink; one throwing sink never stops the others. */
export function composeSinks(...sinks: LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // a broken sink must not break its siblings or the code that logged
      }
    }
  };
}
