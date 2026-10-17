import { afterEach, describe, expect, it } from "bun:test";
import { installLogger, resetLogger } from "@alineo-labs/logger";
import { validateAgentSpec } from "../src/schema";
import { AgentSpecValidationError } from "../src/errors";

afterEach(() => {
  resetLogger();
});

/** Capture the warnings validateAgentSpec logs. The sink takes whole records. */
function captureWarnings(): string[] {
  const seen: string[] = [];
  installLogger({
    level: "warn",
    sink: (record) => {
      if (record.level === "warn") seen.push(record.msg);
    },
  });
  return seen;
}

function issueFor(spec: unknown): string {
  try {
    validateAgentSpec(spec);
  } catch (e) {
    if (e instanceof AgentSpecValidationError) return e.message;
    throw e;
  }
  return "";
}

describe("spec shape: harness and model as objects", () => {
  it("reads the same as the string forms", () => {
    const obj = validateAgentSpec({
      name: "a",
      harness: { id: "pi", version: "1.2.3" },
      model: { provider: "nvidia", id: "nemotron" },
    });
    const flat = validateAgentSpec({
      name: "a",
      harness: "pi",
      harnessVersion: "1.2.3",
      provider: "nvidia",
      model: "nemotron",
    });
    expect(obj).toEqual(flat);
    expect(obj).toMatchObject({
      harness: "pi",
      harnessVersion: "1.2.3",
      provider: "nvidia",
      model: "nemotron",
    });
  });

  it("leaves a spec without a version or provider without those keys", () => {
    const spec = validateAgentSpec({ name: "a", harness: { id: "codex" }, model: { id: "gpt-5" } });
    expect("harnessVersion" in spec).toBe(false);
    expect("provider" in spec).toBe(false);
  });

  it("keeps the string forms working", () => {
    const spec = validateAgentSpec({
      name: "a",
      harness: "claude-code",
      model: "claude-sonnet-5-5",
    });
    expect(spec).toMatchObject({ harness: "claude-code", model: "claude-sonnet-5-5" });
  });

  it("names the supported harnesses when an object names an unknown one", () => {
    expect(issueFor({ name: "a", harness: { id: "cursor" }, model: "m" })).toMatch(
      /Unsupported harness: 'cursor'.*pi, claude-code, codex/s,
    );
  });

  it("asks for the model id when the model object has none", () => {
    expect(issueFor({ name: "a", harness: "pi", model: { provider: "x" } })).toMatch(/model/);
  });
});

describe("spec shape: a conflict is an error, not a silent pick", () => {
  it("rejects two different versions", () => {
    expect(
      issueFor({
        name: "a",
        harness: { id: "pi", version: "1" },
        harnessVersion: "2",
        model: "m",
      }),
    ).toMatch(/conflicts with 'harness.version'/);
  });

  it("accepts the same version written twice", () => {
    expect(
      issueFor({ name: "a", harness: { id: "pi", version: "1" }, harnessVersion: "1", model: "m" }),
    ).toBe("");
  });

  it("rejects two different providers", () => {
    expect(
      issueFor({ name: "a", harness: "pi", provider: "x", model: { provider: "y", id: "m" } }),
    ).toMatch(/conflicts with 'model.provider'/);
  });

  it("rejects a provider the harness does not run on", () => {
    expect(
      issueFor({ name: "a", harness: "claude-code", model: { provider: "nvidia", id: "m" } }),
    ).toMatch(/claude-code harness runs on anthropic models.*'nvidia'/s);
    expect(issueFor({ name: "a", harness: "codex", provider: "anthropic", model: "m" })).toMatch(
      /codex harness runs on openai/,
    );
  });

  it("accepts the native provider, and any provider on pi", () => {
    expect(
      issueFor({ name: "a", harness: "claude-code", model: { provider: "anthropic", id: "m" } }),
    ).toBe("");
    expect(issueFor({ name: "a", harness: "pi", provider: "anything", model: "m" })).toBe("");
  });
});

describe("spec shape: the deprecated top-level fields", () => {
  it("warns once per spec and field, naming the replacement", () => {
    const seen = captureWarnings();
    const spec = { name: "warn-me", harness: "pi", harnessVersion: "1", provider: "x", model: "m" };
    validateAgentSpec(spec);
    validateAgentSpec(spec);
    expect(seen).toHaveLength(2);
    expect(seen.join("\n")).toContain(
      "'harnessVersion', which is deprecated. Use 'harness.version'",
    );
    expect(seen.join("\n")).toContain("'provider', which is deprecated. Use 'model.provider'");
  });

  it("does not warn for the object forms or for the string forms alone", () => {
    const seen = captureWarnings();
    validateAgentSpec({ name: "quiet-1", harness: { id: "pi", version: "1" }, model: { id: "m" } });
    validateAgentSpec({ name: "quiet-2", harness: "pi", model: "m" });
    expect(seen).toHaveLength(0);
  });
});
