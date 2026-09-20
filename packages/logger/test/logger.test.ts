import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, installLogger, resetLogger } from "../src/index.ts";
import type { LogRecord } from "../src/index.ts";

function spyOnStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}
let stderr: ReturnType<typeof spyOnStderr>;

beforeEach(() => {
  resetLogger();
  delete process.env.ALINEO_LOG_LEVEL;
  delete process.env.ALINEO_LOG;
  delete process.env.ALINEO_LOG_FILE;
  delete process.env.ALINEO_LOG_FORMAT;
  stderr = spyOnStderr();
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
  delete process.env.ALINEO_LOG_LEVEL;
  delete process.env.ALINEO_LOG;
});

function capture(): { records: LogRecord[]; sink: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
}

describe("silent by default", () => {
  it("writes nothing when nothing has been installed", () => {
    const log = getLogger("agent");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(stderr).not.toHaveBeenCalled();
    expect(log.isEnabled("error")).toBe(false);
  });

  it("turns on from ALINEO_LOG_LEVEL with no code, even for a logger created earlier", () => {
    const log = getLogger("agent"); // created before the env is read
    process.env.ALINEO_LOG_LEVEL = "info";
    log.info("hello", { n: 1 });
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      component: "agent",
      msg: "hello",
      n: 1,
    });
  });

  it("ALINEO_LOG_LEVEL=silent keeps it off", () => {
    process.env.ALINEO_LOG_LEVEL = "silent";
    getLogger("agent").error("nope");
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("installLogger", () => {
  it("filters below the level", () => {
    const { records, sink } = capture();
    installLogger({ level: "warn", sink });
    const log = getLogger("agent");
    log.info("no");
    log.warn("yes");
    log.error("yes too");
    expect(records.map((r) => r.msg)).toEqual(["yes", "yes too"]);
  });

  it("applies per-component levels and the * default", () => {
    const { records, sink } = capture();
    installLogger({ level: "error", components: { agent: "debug", "*": "warn" }, sink });
    getLogger("agent").debug("agent debug");
    getLogger("alineod").info("alineod info (dropped: * is warn)");
    getLogger("alineod").warn("alineod warn");
    expect(records.map((r) => r.msg)).toEqual(["agent debug", "alineod warn"]);
  });

  it("works for loggers created before the install", () => {
    const log = getLogger("agent");
    const { records, sink } = capture();
    installLogger({ level: "info", sink });
    log.info("late");
    expect(records).toHaveLength(1);
  });

  it("last install wins", () => {
    const first = capture();
    const second = capture();
    installLogger({ sink: first.sink });
    installLogger({ sink: second.sink });
    getLogger("agent").info("x");
    expect(first.records).toHaveLength(0);
    expect(second.records).toHaveLength(1);
  });

  it("adds global fields to every record", () => {
    const { records, sink } = capture();
    installLogger({ sink, fields: { pid: 7 } });
    getLogger("agent").info("x", { a: 1 });
    expect(records[0]?.fields).toEqual({ pid: 7, a: 1 });
  });

  it("isEnabled follows the level", () => {
    installLogger({ level: "warn", sink: () => {} });
    const log = getLogger("agent");
    expect(log.isEnabled("info")).toBe(false);
    expect(log.isEnabled("warn")).toBe(true);
  });
});

describe("child loggers", () => {
  it("bind fields and merge them under the call's own fields", () => {
    const { records, sink } = capture();
    installLogger({ sink });
    const child = getLogger("alineod").child({ runId: "r1", agentId: "a1" });
    child.info("spawned", { agentId: "override", extra: true });
    expect(records[0]?.fields).toEqual({ runId: "r1", agentId: "override", extra: true });
  });

  it("nest", () => {
    const { records, sink } = capture();
    installLogger({ sink });
    getLogger("alineod").child({ runId: "r1" }).child({ agentId: "a1" }).info("x");
    expect(records[0]?.fields).toEqual({ runId: "r1", agentId: "a1" });
  });

  it("keep the parent's component and level rules", () => {
    const { records, sink } = capture();
    installLogger({ level: "silent", components: { alineod: "info" }, sink });
    getLogger("alineod").child({ a: 1 }).info("yes");
    getLogger("agent").child({ a: 1 }).info("no");
    expect(records.map((r) => r.component)).toEqual(["alineod"]);
  });
});

describe("robustness", () => {
  it("a throwing sink never breaks the caller", () => {
    installLogger({
      sink: () => {
        throw new Error("sink exploded");
      },
    });
    expect(() => {
      getLogger("agent").info("x");
    }).not.toThrow();
  });

  it("shares one switch across separate copies of the module", async () => {
    const { records, sink } = capture();
    vi.resetModules();
    const copyA = await import("../src/logger.ts");
    vi.resetModules();
    const copyB = await import("../src/logger.ts");
    expect(copyA).not.toBe(copyB);
    copyA.installLogger({ sink });
    copyB.getLogger("agent").info("from copy B");
    expect(records.map((r) => r.msg)).toEqual(["from copy B"]);
  });
});
