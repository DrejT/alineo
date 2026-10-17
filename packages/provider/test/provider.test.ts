import { describe, expect, it } from "vitest";
import type {
  SandboxProviderDescriptor,
  SandboxInfo,
  SandboxState,
  SandboxProvider,
} from "../src/index.ts";

/**
 * The smallest thing that can stand in for a provider. It exists so a change to the interface
 * that breaks a hand-written implementation fails here, at compile time, before it fails in an
 * adapter somewhere else.
 */
function inMemoryProvider(): SandboxProvider {
  const sandboxes = new Map<string, SandboxInfo>();
  const descriptor: SandboxProviderDescriptor = {
    id: "memory",
    label: "In memory",
    capabilities: {
      snapshot: false,
      pause: false,
      egress: false,
      credentials: false,
      pty: false,
      code: false,
    },
  };

  const missing = (id: string): never => {
    throw new Error(`no sandbox ${id}`);
  };

  return {
    id: "memory",
    descriptor,
    createSandbox: async () => {
      const info: SandboxInfo = { id: `sb-${sandboxes.size + 1}`, state: "running" };
      sandboxes.set(info.id, info);
      return info;
    },
    getSandbox: async (id) => sandboxes.get(id) ?? missing(id),
    listSandboxes: async (filter) =>
      [...sandboxes.values()].filter((s) => !filter?.state || s.state === filter.state),
    deleteSandbox: async (id) => {
      sandboxes.delete(id);
    },
    pauseSandbox: async () => {},
    resumeSandbox: async () => {},
    createSnapshot: async (sandboxId) => ({
      id: "snap-1",
      sandboxId,
      state: "ready",
      createdAt: "now",
    }),
    getSnapshot: async (id) => ({ id, sandboxId: "sb-1", state: "ready", createdAt: "now" }),
    getEndpoint: async (_id, port) => ({ endpoint: `localhost:${port}` }),
    getDiagnosticLogs: async () => [],
    getDiagnosticEvents: async () => [],
    connectExec: async () => {
      throw new Error("not supported");
    },
  };
}

describe("SandboxProvider", () => {
  it("can be implemented with only the required methods", async () => {
    const provider = inMemoryProvider();

    const created = await provider.createSandbox({ image: { uri: "x" } });
    expect(created.state satisfies SandboxState).toBe("running");
    expect(await provider.listSandboxes({ state: "running" })).toHaveLength(1);

    await provider.deleteSandbox(created.id);
    expect(await provider.listSandboxes()).toHaveLength(0);
  });

  it("leaves pty and egress to providers that have them", () => {
    const provider = inMemoryProvider();
    expect(provider.connectPty).toBeUndefined();
    expect(provider.egress).toBeUndefined();
    expect(provider.descriptor.capabilities.pty).toBe(false);
  });
});
