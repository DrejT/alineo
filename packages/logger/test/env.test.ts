import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  installLoggerFromEnv,
  parseLogSpec,
  readEnvConfig,
  resetLogger,
} from "../src/index.ts";
import type { LogRecord } from "../src/index.ts";

beforeEach(resetLogger);
afterEach(resetLogger);

describe("parseLogSpec", () => {
  it("parses component=level entries", () => {
    expect(parseLogSpec("agent=debug,alineod=info")).toEqual({
      components: { agent: "debug", alineod: "info" },
      invalid: [],
    });
  });

  it("takes a bare level or *=level as the default", () => {
    expect(parseLogSpec("warn").level).toBe("warn");
    expect(parseLogSpec("*=error,agent=debug")).toMatchObject({
      level: "error",
      components: { agent: "debug" },
    });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseLogSpec(" Agent = DEBUG , INFO ")).toMatchObject({
      level: "info",
      components: { Agent: "debug" },
    });
  });

  it("reports invalid tokens instead of throwing", () => {
    const spec = parseLogSpec("agent=loud,,=info,nonsense,alineod=warn");
    expect(spec.components).toEqual({ alineod: "warn" });
    expect(spec.invalid).toEqual(["agent=loud", "=info", "nonsense"]);
  });
});

describe("readEnvConfig", () => {
  it("returns null when no logging variable is set", () => {
    expect(readEnvConfig({})).toBeNull();
  });

  it("a format alone is read but does not ask for logging", () => {
    expect(readEnvConfig({ ALINEO_LOG_FORMAT: "json" })).toMatchObject({
      format: "json",
      requested: false,
    });
  });

  it("reads level, spec, format and file", () => {
    expect(
      readEnvConfig({
        ALINEO_LOG_LEVEL: "warn",
        ALINEO_LOG: "agent=debug",
        ALINEO_LOG_FORMAT: "PRETTY",
        ALINEO_LOG_FILE: "/tmp/x.log",
      }),
    ).toEqual({
      level: "warn",
      components: { agent: "debug" },
      format: "pretty",
      file: "/tmp/x.log",
      invalid: [],
      requested: true,
    });
  });

  it("lets ALINEO_LOG's bare level win over ALINEO_LOG_LEVEL", () => {
    expect(readEnvConfig({ ALINEO_LOG_LEVEL: "error", ALINEO_LOG: "debug" })?.level).toBe("debug");
  });

  it("collects invalid values", () => {
    const config = readEnvConfig({ ALINEO_LOG_LEVEL: "loud", ALINEO_LOG_FORMAT: "xml" });
    expect(config?.invalid).toEqual(["ALINEO_LOG_LEVEL=loud", "ALINEO_LOG_FORMAT=xml"]);
  });
});

describe("installLoggerFromEnv", () => {
  it("honours ALINEO_LOG_FORMAT on its own (the app supplies the level)", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      installLoggerFromEnv({ env: { ALINEO_LOG_FORMAT: "pretty" }, defaultLevel: "info" });
      getLogger("agent").info("starting sandbox", { name: "x" });
      expect(write).toHaveBeenCalledWith("[agent] starting sandbox name=x\n");
    } finally {
      write.mockRestore();
    }
  });

  it("a format alone does not switch logging on for a library", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const saved = process.env.ALINEO_LOG_FORMAT;
    process.env.ALINEO_LOG_FORMAT = "pretty";
    try {
      getLogger("agent").info("should stay silent");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      if (saved === undefined) delete process.env.ALINEO_LOG_FORMAT;
      else process.env.ALINEO_LOG_FORMAT = saved;
    }
  });

  function run(env: Record<string, string>, defaultLevel?: "info") {
    const records: LogRecord[] = [];
    installLoggerFromEnv({ env, defaultLevel, sink: (r) => records.push(r) });
    return records;
  }

  it("uses the app's default level when the env is empty", () => {
    const records = run({}, "info");
    getLogger("alineod").info("up");
    getLogger("alineod").debug("noise");
    expect(records.map((r) => r.msg)).toEqual(["up"]);
  });

  it("stays silent with no env and no default", () => {
    const records = run({});
    getLogger("alineod").error("x");
    expect(records).toHaveLength(0);
  });

  it("lets the env override the app default", () => {
    const records = run({ ALINEO_LOG_LEVEL: "silent" }, "info");
    getLogger("alineod").error("x");
    expect(records).toHaveLength(0);
  });

  it("a component-only spec turns on just that component", () => {
    const records = run({ ALINEO_LOG: "agent=debug" });
    getLogger("agent").debug("yes");
    getLogger("alineod").error("no");
    expect(records.map((r) => r.msg)).toEqual(["yes"]);
  });

  it("warns about invalid settings once it is on", () => {
    const records = run({ ALINEO_LOG_LEVEL: "info", ALINEO_LOG: "agent=loud" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      component: "logger",
      fields: { problems: ["ALINEO_LOG:agent=loud"] },
    });
  });
});
