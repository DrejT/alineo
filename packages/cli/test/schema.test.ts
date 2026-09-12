import { describe, it, expect } from "bun:test";
import { validateAgentSpec } from "../src/schema.js";

describe("validateAgentSpec", () => {
  it("accepts a valid minimal spec", () => {
    const spec = validateAgentSpec({ name: "my-agent", cli: "pi" });
    expect(spec.name).toBe("my-agent");
    expect(spec.cli).toBe("pi");
  });

  it("accepts all optional fields", () => {
    const spec = validateAgentSpec({
      name: "full-agent",
      cli: "pi",
      cliVersion: "latest",
      title: "Full Agent",
      description: "An agent with all fields",
      author: "alice",
      categories: ["dev", "review"],
      packages: ["nodejs_22", "git"],
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      resources: { cpu: "1000m", memory: "1Gi" },
      metadata: { team: "infra" },
      registryDependencies: ["https://example.com/base.json"],
    });

    expect(spec.title).toBe("Full Agent");
    expect(spec.packages).toEqual(["nodejs_22", "git"]);
    expect(spec.registryDependencies).toEqual(["https://example.com/base.json"]);
  });

  it("throws when name is missing", () => {
    expect(() => validateAgentSpec({ cli: "pi" })).toThrow(/name/);
  });

  it("throws when cli is missing", () => {
    expect(() => validateAgentSpec({ name: "my-agent" })).toThrow(/pi/);
  });

  it("throws for unsupported cli", () => {
    expect(() => validateAgentSpec({ name: "my-agent", cli: "unknown-cli" })).toThrow(
      /Unsupported CLI/,
    );
  });

  it("throws for non-object input", () => {
    expect(() => validateAgentSpec(null)).toThrow();
    expect(() => validateAgentSpec("string")).toThrow();
    expect(() => validateAgentSpec(42)).toThrow();
  });
});
