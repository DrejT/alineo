import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEnv, envTable, readEnv, readEnvGroup } from "../src/env";

const PORT = defineEnv({
  name: "ALINEOD_PORT",
  description: "HTTP + SSE listen port.",
  schema: z.coerce.number().int().positive(),
  default: 4600,
});

describe("readEnv", () => {
  test("returns the default when unset", () => {
    expect(readEnv(PORT, { env: {} })).toBe(4600);
  });

  test("parses a valid value", () => {
    expect(readEnv(PORT, { env: { ALINEOD_PORT: "5000" } })).toBe(5000);
  });

  test("rejects a non-numeric value instead of yielding NaN", () => {
    // `Number(process.env.X ?? default)` used to make this NaN and start the daemon anyway.
    expect(() => readEnv(PORT, { env: { ALINEOD_PORT: "abc" } })).toThrow(/ALINEOD_PORT/);
    expect(() => readEnv(PORT, { env: { ALINEOD_PORT: "abc" } })).toThrow(/"abc"/);
  });

  test("rejects a value that parses but breaks a constraint", () => {
    expect(() => readEnv(PORT, { env: { ALINEOD_PORT: "-1" } })).toThrow(/ALINEOD_PORT/);
  });

  test("honours an older name and reports it", () => {
    const withAlias = defineEnv({ ...PORT, aliases: ["LEGACY_PORT"] });
    const warnings: string[] = [];
    const value = readEnv(withAlias, {
      env: { LEGACY_PORT: "7000" },
      onWarning: (m) => warnings.push(m),
    });
    expect(value).toBe(7000);
    expect(warnings).toEqual(["LEGACY_PORT is deprecated; use ALINEOD_PORT"]);
  });

  test("the canonical name wins over an alias", () => {
    const withAlias = defineEnv({ ...PORT, aliases: ["LEGACY_PORT"] });
    const warnings: string[] = [];
    const value = readEnv(withAlias, {
      env: { ALINEOD_PORT: "1", LEGACY_PORT: "2" },
      onWarning: (m) => warnings.push(m),
    });
    expect(value).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe("readEnvGroup", () => {
  test("resolves a whole group", () => {
    const group = {
      port: PORT,
      dbPath: defineEnv({
        name: "ALINEOD_DB_PATH",
        description: "alineod's own state.",
        schema: z.string().min(1),
        default: "./data/alineod.db",
      }),
    };
    expect(readEnvGroup(group, { env: { ALINEOD_PORT: "9" } })).toEqual({
      port: 9,
      dbPath: "./data/alineod.db",
    });
  });
});

describe("envTable", () => {
  test("renders declared variables as Markdown", () => {
    const table = envTable([defineEnv({ ...PORT, aliases: ["LEGACY_PORT"] })]);
    expect(table).toContain("| Variable | Description | Default | Older names |");
    expect(table).toContain("`ALINEOD_PORT`");
    expect(table).toContain("`LEGACY_PORT`");
    expect(table).toContain("4600");
  });
});
