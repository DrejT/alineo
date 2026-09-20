import type { LogRecord } from "./types";

function quote(value: string): string {
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * JSON replacer that keeps logging from throwing: Errors become `{ name, message, stack }`,
 * bigints become strings, and a repeated object reference becomes `"[Circular]"`. (A shared,
 * non-circular reference is also collapsed — an acceptable loss for log output.)
 */
function jsonReplacer(seen: WeakSet<object>): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

function prettyValue(value: unknown): string {
  if (value instanceof Error) return quote(value.message);
  if (typeof value === "string") return quote(value);
  if (typeof value === "function") return "[Function]";
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value, jsonReplacer(new WeakSet()));
    } catch {
      return "[Unserializable]";
    }
  }
  return String(value);
}

/**
 * Human-readable single line for terminals: `[agent] sandbox ready elapsed=1.2s sandboxId=abc`.
 * Non-info levels are labelled (`[agent] warn: …`); `undefined` fields are skipped.
 */
export function formatPretty(record: LogRecord): string {
  const prefix =
    record.level === "info" ? `[${record.component}]` : `[${record.component}] ${record.level}:`;
  const parts = [prefix, record.msg];
  for (const [key, value] of Object.entries(record.fields)) {
    if (value !== undefined) parts.push(`${key}=${prettyValue(value)}`);
  }
  return parts.join(" ");
}

/** One JSON object per line. `ts`, `level`, `component`, `msg` come first and can't be overridden by fields. */
export function formatJson(record: LogRecord): string {
  const line: Record<string, unknown> = {
    ts: new Date(record.ts).toISOString(),
    level: record.level,
    component: record.component,
    msg: record.msg,
  };
  for (const [key, value] of Object.entries(record.fields)) {
    if (!(key in line)) line[key] = value;
  }
  try {
    return JSON.stringify(line, jsonReplacer(new WeakSet()));
  } catch {
    return JSON.stringify({
      ts: line.ts,
      level: line.level,
      component: line.component,
      msg: line.msg,
      fieldsError: "unserializable",
    });
  }
}
