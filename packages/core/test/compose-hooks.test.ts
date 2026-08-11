import { describe, expect, it } from "vitest";
import { composeHooks } from "../src/sandbox/hooks.ts";
import type { SandboxHooks } from "../src/sandbox/types.ts";

describe("composeHooks", () => {
  it("fans an event out to every hook, in order", () => {
    const calls: string[] = [];
    const a: SandboxHooks = { onSandboxCreated: () => calls.push("a") };
    const b: SandboxHooks = { onSandboxCreated: () => calls.push("b") };

    composeHooks([a, b]).onSandboxCreated?.("sb-1", "my-sandbox");

    expect(calls).toEqual(["a", "b"]);
  });

  it("skips hooks that don't implement a given method", () => {
    const calls: string[] = [];
    const a: SandboxHooks = { onExecStart: () => calls.push("a") };
    const b: SandboxHooks = {};

    expect(() => composeHooks([a, b]).onExecStart?.("sb-1", 0, "echo hi")).not.toThrow();
    expect(calls).toEqual(["a"]);
  });

  it("filters out undefined entries", () => {
    const calls: string[] = [];
    const a: SandboxHooks = { onSandboxClosed: () => calls.push("a") };

    composeHooks([a, undefined]).onSandboxClosed?.("sb-1");

    expect(calls).toEqual(["a"]);
  });

  it("isolates a throwing hook — siblings and the caller are unaffected", () => {
    const calls: string[] = [];
    const broken: SandboxHooks = {
      onExecComplete: () => {
        throw new Error("boom");
      },
    };
    const fine: SandboxHooks = { onExecComplete: () => calls.push("fine") };

    const errors: { hookIndex: number; method: string }[] = [];
    const hooks = composeHooks([broken, fine], {
      onHookError: (error, hookIndex, method) => {
        expect((error as Error).message).toBe("boom");
        errors.push({ hookIndex, method });
      },
    });

    expect(() =>
      hooks.onExecComplete?.("sb-1", 0, { stdout: "", stderr: "", exitCode: 0 }),
    ).not.toThrow();

    expect(calls).toEqual(["fine"]);
    expect(errors).toEqual([{ hookIndex: 0, method: "onExecComplete" }]);
  });

  it("swallows errors silently when onHookError isn't provided", () => {
    const broken: SandboxHooks = {
      onSandboxFailed: () => {
        throw new Error("boom");
      },
    };

    expect(() => composeHooks([broken]).onSandboxFailed?.("sb-1", new Error("orig"))).not.toThrow();
  });
});
