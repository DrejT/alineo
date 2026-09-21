import { describe, it, expect } from "bun:test";
import { validateAgentSpec, type AgentSpec } from "../src/schema";
import { AgentSpecValidationError } from "../src/errors";

describe("validateAgentSpec", () => {
  it("accepts a valid minimal spec", () => {
    const spec = validateAgentSpec({ name: "my-agent", cli: "pi", model: "some-model" });
    expect(spec.name).toBe("my-agent");
    expect(spec.cli).toBe("pi");
    expect(spec.model).toBe("some-model");
  });

  it("accepts all optional fields", () => {
    const spec = validateAgentSpec({
      name: "full-agent",
      cli: "pi",
      model: "some-model",
      cliVersion: "latest",
      title: "Full Agent",
      description: "An agent with all fields",
      author: "alice",
      categories: ["dev", "review"],
      packages: ["nodejs_22", "git", "ripgrep"],
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      resources: { cpu: "1000m", memory: "2Gi" },
      metadata: { team: "infra" },
      registryDependencies: ["https://example.com/base.json"],
      teamId: "acme",
      resourceId: "billing-resource",
    });
    expect(spec.title).toBe("Full Agent");
    expect(spec.packages).toEqual(["nodejs_22", "git", "ripgrep"]);
    expect(spec.registryDependencies).toEqual(["https://example.com/base.json"]);
    expect(spec.env).toEqual({ ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" });
    expect(spec.teamId).toBe("acme");
    expect(spec.resourceId).toBe("billing-resource");
  });

  it("leaves teamId/resourceId undefined when omitted", () => {
    const spec = validateAgentSpec({ name: "my-agent", cli: "pi", model: "some-model" });
    expect(spec.teamId).toBeUndefined();
    expect(spec.resourceId).toBeUndefined();
  });

  it("throws when name is missing", () => {
    expect(() => validateAgentSpec({ cli: "pi", model: "some-model" })).toThrow(/name/);
  });

  it("throws when model is missing", () => {
    // Optional `model` used to mean the agent silently ran on the harness's own default,
    // leaving no record of what produced a result.
    expect(() => validateAgentSpec({ name: "my-agent", cli: "pi" })).toThrow(/model/);
  });

  it("throws when model is empty", () => {
    expect(() => validateAgentSpec({ name: "my-agent", cli: "pi", model: "" })).toThrow(/model/i);
  });

  it("throws when cli is missing", () => {
    expect(() => validateAgentSpec({ name: "my-agent", model: "some-model" })).toThrow(/pi/);
  });

  it("throws for unsupported cli value", () => {
    expect(() => validateAgentSpec({ name: "x", cli: "docker", model: "some-model" })).toThrow(
      /Unsupported CLI/,
    );
  });

  it("throws for null", () => {
    expect(() => validateAgentSpec(null)).toThrow();
  });

  it("throws for non-object types", () => {
    expect(() => validateAgentSpec("string")).toThrow();
    expect(() => validateAgentSpec(42)).toThrow();
    expect(() => validateAgentSpec([])).toThrow();
  });

  it("accepts a valid spawnDepth", () => {
    const spec = validateAgentSpec({
      name: "master",
      cli: "pi",
      model: "some-model",
      spawnDepth: 1,
    });
    expect(spec.spawnDepth).toBe(1);
  });

  it("accepts spawnDepth of 0", () => {
    const spec = validateAgentSpec({
      name: "worker",
      cli: "pi",
      model: "some-model",
      spawnDepth: 0,
    });
    expect(spec.spawnDepth).toBe(0);
  });

  it("omits spawnDepth when not set", () => {
    const spec = validateAgentSpec({ name: "plain", cli: "pi", model: "some-model" });
    expect(spec.spawnDepth).toBeUndefined();
  });

  it("throws for a negative spawnDepth", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", spawnDepth: -1 }),
    ).toThrow(/spawnDepth/);
  });

  it("throws for a non-integer spawnDepth", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", spawnDepth: 1.5 }),
    ).toThrow(/spawnDepth/);
  });

  it("throws for a non-numeric spawnDepth", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", spawnDepth: "1" }),
    ).toThrow(/spawnDepth/);
  });

  it("accepts a valid maxAgents", () => {
    const spec = validateAgentSpec({
      name: "master",
      cli: "pi",
      model: "some-model",
      maxAgents: 5,
    });
    expect(spec.maxAgents).toBe(5);
  });

  it("accepts maxAgents of 0", () => {
    const spec = validateAgentSpec({
      name: "worker",
      cli: "pi",
      model: "some-model",
      maxAgents: 0,
    });
    expect(spec.maxAgents).toBe(0);
  });

  it("omits maxAgents when not set", () => {
    const spec = validateAgentSpec({ name: "plain", cli: "pi", model: "some-model" });
    expect(spec.maxAgents).toBeUndefined();
  });

  it("throws for a negative maxAgents", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", maxAgents: -1 }),
    ).toThrow(/maxAgents/);
  });

  it("throws for a non-integer maxAgents", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", maxAgents: 1.5 }),
    ).toThrow(/maxAgents/);
  });

  it("throws for a non-numeric maxAgents", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", maxAgents: "1" }),
    ).toThrow(/maxAgents/);
  });

  // -- #185: aggregated, structured validation errors ------------------------------------------

  it("throws AgentSpecValidationError, not a bare Error", () => {
    try {
      validateAgentSpec({ cli: "pi" });
      throw new Error("expected validateAgentSpec to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentSpecValidationError);
    }
  });

  it("aggregates every problem in one throw instead of failing on the first", () => {
    try {
      validateAgentSpec({ cli: "docker", spawnDepth: -1, resources: { cpu: 5 } });
      throw new Error("expected validateAgentSpec to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentSpecValidationError);
      const err = e as AgentSpecValidationError;
      // name, cli, model, spawnDepth, resources.cpu, resources.memory -- six independent
      // problems, all reported, not just the first one encountered.
      expect(err.issues.length).toBe(6);
      const paths = err.issues.map((i) => i.path.join("."));
      expect(paths).toEqual(
        // bun-types' expect.arrayContaining()'s generic defaults to `any`, which leaks into
        // toEqual's argument here even though the array literal itself is fully typed.
        // eslint-disable-next-line typescript/no-unsafe-argument
        expect.arrayContaining([
          "name",
          "cli",
          "model",
          "spawnDepth",
          "resources.cpu",
          "resources.memory",
        ]),
      );
    }
  });

  it("validates resources field types, not just its presence", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", resources: { cpu: 500, memory: "256Mi" } }),
    ).toThrow(/resources/);
  });

  it("validates setup step shape", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", setup: [{ name: "missing run field" }] }),
    ).toThrow(/setup/);
  });

  it("validates env values must be strings", () => {
    expect(() => validateAgentSpec({ name: "x", cli: "pi", env: { PORT: 3000 } })).toThrow(/env/);
  });

  it("accepts a permissions mode shorthand", () => {
    expect(
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", permissions: "readonly" })
        .permissions,
    ).toBe("readonly");
    expect(
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", permissions: "ask" })
        .permissions,
    ).toBe("ask");
  });

  it("accepts a full permissions policy", () => {
    const spec = validateAgentSpec({
      name: "x",
      cli: "pi",
      model: "some-model",
      permissions: {
        default: "deny",
        rules: [
          { tool: "read", action: "allow" },
          { tool: "bash", pattern: "git *", action: "ask" },
          { tool: "bash", action: "classify" },
          { tool: "bash", action: "rate_limit", limit: { count: 5, windowMs: 60000 } },
        ],
        disabledTools: ["powershell"],
        restrictToTools: ["read", "grep", "bash"],
      },
    });
    expect(spec.permissions).toMatchObject({
      default: "deny",
      disabledTools: ["powershell"],
      restrictToTools: ["read", "grep", "bash"],
    });
  });

  it("rejects an unknown permissions mode / action", () => {
    expect(() =>
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model", permissions: "yolo" }),
    ).toThrow(/permissions/);
    expect(() =>
      validateAgentSpec({
        name: "x",
        cli: "pi",
        model: "some-model",
        permissions: { rules: [{ tool: "bash", action: "maybe" }] },
      }),
    ).toThrow(/permissions/);
  });

  it("leaves permissions undefined when omitted", () => {
    expect(
      validateAgentSpec({ name: "x", cli: "pi", model: "some-model" }).permissions,
    ).toBeUndefined();
  });

  it("passes unknown top-level fields through untouched (forward-compat)", () => {
    const spec = validateAgentSpec({
      name: "x",
      cli: "pi",
      model: "some-model",
      someFutureField: "kept, not stripped",
    }) as AgentSpec & { someFutureField: string };
    expect(spec.someFutureField).toBe("kept, not stripped");
  });
});
