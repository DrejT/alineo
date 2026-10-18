import { createHarness, registeredHarnesses, requireHarnessCapability } from "alineo";
import { describe, expect, test } from "bun:test";

describe("the harness interface", () => {
  test("pi, claude-code and codex are registered", () => {
    expect(registeredHarnesses().sort()).toEqual(["claude-code", "codex", "pi"]);
  });

  test("each harness declares every capability as a boolean", () => {
    for (const id of registeredHarnesses()) {
      const { capabilities } = createHarness(id as "pi");
      for (const value of Object.values(capabilities)) expect(typeof value).toBe("boolean");
    }
  });

  test("the harnesses differ where the changesets say they do", () => {
    expect(createHarness("pi").capabilities.steer).toBe(true);
    expect(createHarness("claude-code").capabilities.steer).toBe(false);
    expect(createHarness("claude-code").capabilities.fork).toBe(true);
    expect(createHarness("codex").capabilities.steer).toBe(true);
    expect(createHarness("codex").capabilities.followUp).toBe(false);
  });

  test("an unknown harness is SPEC_INVALID and the hint names the real ones", () => {
    let thrown: (Error & { code?: string; hint?: string }) | undefined;
    try {
      createHarness("gemini" as never);
    } catch (e) {
      thrown = e as Error & { code?: string; hint?: string };
    }
    expect(thrown?.code).toBe("SPEC_INVALID");
    expect(thrown?.hint).toContain("claude-code");
  });

  test("a capability the harness lacks is refused with CAPABILITY_UNSUPPORTED", () => {
    let thrown: (Error & { code?: string }) | undefined;
    try {
      requireHarnessCapability(createHarness("claude-code"), "steer");
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    expect(thrown?.code).toBe("CAPABILITY_UNSUPPORTED");
  });
});
