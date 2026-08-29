import { describe, it, expect } from "bun:test";
import { resolveChildResourceId } from "../src/agent/validation";

describe("resolveChildResourceId", () => {
  it("defaults to the child spec's name when resourceId is unset", () => {
    expect(resolveChildResourceId({ name: "billing-helper" })).toBe("billing-helper");
  });

  it("prefers an explicit resourceId over the name", () => {
    expect(resolveChildResourceId({ name: "billing-helper", resourceId: "billing-resource" })).toBe(
      "billing-resource",
    );
  });

  it("is stable regardless of what the sandbox-level fork later renames .name to", () => {
    // The exact bug this exists to prevent: Alineo.spawn() overwrites the child's own
    // .name to the forked sandbox's auto-generated ledger name (fork-<parent>-<id>) for
    // display purposes — resolveChildResourceId must be computed from the ORIGINAL child
    // spec, before that rename, or the child's memory scope would silently become the
    // auto-generated name instead of the identity its own spec declared.
    const childSpec = { name: "billing-helper" };
    const frozen = resolveChildResourceId(childSpec);
    const renamed = { ...childSpec, name: "fork-orchestrator-a1b2c3d4" };

    expect(frozen).toBe("billing-helper");
    expect(resolveChildResourceId(renamed)).not.toBe(frozen);
  });
});
