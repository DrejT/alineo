import { describe, expect, it } from "vitest";
import { expectTypeOf } from "vitest";
import type { z } from "zod";
import { AgentSpecSchema, type AgentSpec } from "../src/index";

/**
 * `AgentSpec` is maintained twice on purpose: once as a documented `interface`, once as
 * `AgentSpecSchema`. The interface carries doc comments that `z.infer<>` would erase, and
 * they are what a reader sees on hover.
 *
 * Two hand-maintained copies of one shape is exactly what this package exists to end, so the
 * pair has to be provably identical. This assertion is the price of keeping the docs: it
 * fails at compile time the moment a field is added to one and not the other.
 */
describe("AgentSpec and AgentSpecSchema cannot drift", () => {
  // Read off the schema's `shape`, not `z.infer` of the schema itself. `AgentSpecSchema` is
  // `.loose()` — and so are several of its nested object schemas — so the inferred type
  // carries `[k: string]: unknown` index signatures for the unknown keys it passes through.
  // An index signature makes `keyof` collapse to `string` and makes every structural
  // comparison vacuously true, which would leave this file asserting nothing at all.
  type SchemaKeys = keyof (typeof AgentSpecSchema)["shape"];
  type InterfaceKeys = keyof AgentSpec;

  it("declares the same field names on both sides", () => {
    // The drift that actually matters: a field added to one copy and not the other.
    expectTypeOf<SchemaKeys>().toEqualTypeOf<InterfaceKeys>();
  });

  it("parses a fully-populated spec typed as the interface", () => {
    // The per-field type check, done at runtime rather than in the type system: several
    // nested schemas are `.loose()` too, so their inferred types carry index signatures a
    // plain interface can never be assignable to, and a structural comparison would have to
    // strip them recursively to say anything true. Building one spec that exercises every
    // field and pushing it through the schema catches the same drift — a field whose type
    // disagrees fails to parse.
    const spec: AgentSpec = {
      $schema: "https://registry.alineo.tech/spec/agent.json",
      name: "full",
      title: "Full",
      description: "every field",
      author: "alineo",
      categories: ["test"],
      harness: "pi",
      harnessVersion: "1.2.3",
      provider: "nvidia",
      model: "m",
      packages: ["ripgrep"],
      setup: [{ name: "install", run: "npm ci" }],
      env: {
        PLAIN: "${HOST_VAR}",
        BOUND: {
          credential: "${GITHUB_TOKEN}",
          host: "api.github.com",
          pathPrefix: "/repos",
          injection: { type: "header", name: "Authorization" },
          approval: "hold",
        },
      },
      resources: { cpu: "500m", memory: "1Gi" },
      spawnDepth: 2,
      maxAgents: 10,
      permissions: {
        default: "ask",
        rules: [{ tool: "bash", pattern: "git *", action: "allow" }],
        disabledTools: ["write"],
        restrictToTools: ["read", "bash"],
      },
    };
    expect(() => AgentSpecSchema.parse(spec)).not.toThrow();
  });

  it("agrees on which fields are required", () => {
    type RequiredIn<T> = {
      [K in keyof T]-?: object extends Pick<T, K> ? never : K;
    }[keyof T];
    expectTypeOf<RequiredIn<AgentSpec>>().toEqualTypeOf<"name" | "harness" | "model">();
  });
});

describe("AgentSpecSchema", () => {
  it("accepts a minimal spec", () => {
    const spec = AgentSpecSchema.parse({ name: "a", harness: "pi", model: "m" });
    expect(spec).toMatchObject({ name: "a", harness: "pi", model: "m" });
  });

  it("passes unknown keys through rather than stripping or rejecting them", () => {
    // Forward compatibility: a spec written for a newer alineo must still load on an older
    // one, minus whatever it does not understand.
    const spec = AgentSpecSchema.parse({
      name: "a",
      harness: "pi",
      model: "m",
      somethingNewer: 1,
    });
    expect(spec).toMatchObject({ somethingNewer: 1 });
  });

  it("still rejects what it always rejected", () => {
    expect(() => AgentSpecSchema.parse({ name: "a", harness: "pi" })).toThrow();
    expect(() => AgentSpecSchema.parse({ harness: "pi", model: "m" })).toThrow();
    expect(() => AgentSpecSchema.parse({ name: "a", harness: "docker", model: "m" })).toThrow();
  });
});
