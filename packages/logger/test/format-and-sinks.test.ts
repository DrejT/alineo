import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeSinks, fileSink, formatJson, formatPretty } from "../src/index.ts";
import type { LogRecord } from "../src/index.ts";

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: Date.UTC(2026, 8, 19, 12, 0, 0),
    level: "info",
    component: "agent",
    msg: "sandbox ready",
    fields: {},
    ...overrides,
  };
}

describe("formatPretty", () => {
  it("renders `[component] msg key=value`", () => {
    const line = formatPretty(record({ fields: { elapsed: "1.2s", sandboxId: "sbx-1" } }));
    expect(line).toBe("[agent] sandbox ready elapsed=1.2s sandboxId=sbx-1");
  });

  it("labels non-info levels", () => {
    expect(formatPretty(record({ level: "warn", msg: "slow" }))).toBe("[agent] warn: slow");
  });

  it("quotes values with spaces, skips undefined, prints error messages", () => {
    const line = formatPretty(
      record({ fields: { note: "two words", gone: undefined, err: new Error("boom") } }),
    );
    expect(line).toBe('[agent] sandbox ready note="two words" err=boom');
  });

  it("serializes objects and survives circular ones", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(formatPretty(record({ fields: { obj: { x: 1 } } }))).toContain('obj={"x":1}');
    expect(() => formatPretty(record({ fields: { loop } }))).not.toThrow();
  });
});

describe("formatJson", () => {
  it("emits one JSON object with ts/level/component/msg first", () => {
    const line = formatJson(record({ fields: { n: 1 } }));
    expect(JSON.parse(line)).toEqual({
      ts: "2026-09-19T12:00:00.000Z",
      level: "info",
      component: "agent",
      msg: "sandbox ready",
      n: 1,
    });
    expect(Object.keys(JSON.parse(line) as object).slice(0, 4)).toEqual([
      "ts",
      "level",
      "component",
      "msg",
    ]);
  });

  it("does not let fields clobber the reserved keys", () => {
    const parsed = JSON.parse(formatJson(record({ fields: { level: "error", msg: "evil" } }))) as {
      level: string;
      msg: string;
    };
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("sandbox ready");
  });

  it("serializes Errors, bigints and circular references without throwing", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const parsed = JSON.parse(
      formatJson(record({ fields: { err: new TypeError("bad"), big: 10n, loop } })),
    ) as { err: { name: string; message: string }; big: string; loop: { self: string } };
    expect(parsed.err).toMatchObject({ name: "TypeError", message: "bad" });
    expect(parsed.big).toBe("10");
    expect(parsed.loop.self).toBe("[Circular]");
  });
});

describe("sinks", () => {
  it("fileSink appends one line per record and creates parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "alineo-logger-"));
    try {
      const path = join(dir, "nested", "app.log");
      const sink = fileSink(path);
      sink(record({ msg: "one" }));
      sink(record({ msg: "two" }));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["one", "two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composeSinks isolates a throwing sink from its siblings", () => {
    const seen: string[] = [];
    const sink = composeSinks(
      () => {
        throw new Error("first fails");
      },
      (r) => seen.push(r.msg),
    );
    expect(() => {
      sink(record({ msg: "still delivered" }));
    }).not.toThrow();
    expect(seen).toEqual(["still delivered"]);
  });
});
