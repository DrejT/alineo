import { describe, expect, it, vi } from "vitest";
import { createMemoryLifecycleHooks } from "../src/lifecycle-hooks.ts";
import { Memory } from "../src/memory.ts";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";
import type { ResourceRef } from "../src/types.ts";

const ref: ResourceRef = { resourceId: "user-1" };

describe("createMemoryLifecycleHooks", () => {
  it("records the sandboxId on onSandboxCreated", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const hooks = createMemoryLifecycleHooks(memory, ref);

    hooks.onSandboxCreated?.("sb-1", "my-sandbox");
    // Fire-and-forget internally — give the microtask a tick to land.
    await Promise.resolve();
    await Promise.resolve();

    const stored = await memory.workingMemory.get(ref, "__alineo_memory_lastSessionId");
    expect(stored).toBe("sb-1");
  });

  it("records checkpoint metadata on onCheckpoint", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const hooks = createMemoryLifecycleHooks(memory, ref);

    hooks.onCheckpoint?.("sb-1", "snap-1", "my-tag");
    await Promise.resolve();
    await Promise.resolve();

    const stored = (await memory.workingMemory.get(ref, "__alineo_memory_lastCheckpoint")) as
      | { sandboxId: string; snapshotId: string; name?: string; at: number }
      | undefined;
    expect(stored?.sandboxId).toBe("sb-1");
    expect(stored?.snapshotId).toBe("snap-1");
    expect(stored?.name).toBe("my-tag");
    expect(typeof stored?.at).toBe("number");
  });

  it("respects custom key names", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const hooks = createMemoryLifecycleHooks(memory, ref, { sessionKey: "customKey" });

    hooks.onSandboxCreated?.("sb-1", "my-sandbox");
    await Promise.resolve();
    await Promise.resolve();

    expect(await memory.workingMemory.get(ref, "customKey")).toBe("sb-1");
  });

  it("routes a failed write to onError instead of throwing or rejecting unhandled", async () => {
    const failingProvider = new InMemoryWorkingMemoryProvider();
    failingProvider.set = vi.fn().mockRejectedValue(new Error("write failed"));
    const memory = new Memory({ workingMemory: failingProvider });
    const onError = vi.fn();
    const hooks = createMemoryLifecycleHooks(memory, ref, { onError });

    expect(() => hooks.onSandboxCreated?.("sb-1", "my-sandbox")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
