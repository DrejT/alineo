import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "@alineo-labs/provider";
import { SandboxError } from "../src/errors.ts";
import { SandboxHandle } from "../src/sandbox/index.ts";
import { requireCapability } from "../src/sandbox/capabilities.ts";
import type { IStorageAdapter } from "../src/ledger.ts";
import { stubProvider } from "./provider-stub.ts";

function providerWith(capabilities: Partial<SandboxProvider["descriptor"]["capabilities"]>) {
  const base = stubProvider({});
  return stubProvider({
    descriptor: {
      ...base.descriptor,
      capabilities: { ...base.descriptor.capabilities, ...capabilities },
    },
  });
}

function adapter(): IStorageAdapter {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue([]),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
  };
}

describe("requireCapability", () => {
  it("refuses a capability the provider declares it lacks, naming both", () => {
    const provider = providerWith({ egress: false });

    let thrown: unknown;
    try {
      requireCapability(provider, "egress", "sb-1");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SandboxError);
    expect(thrown).toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      sandboxId: "sb-1",
      details: { capability: "egress", provider: "opensandbox" },
    });
    expect((thrown as Error).message).toBe("The opensandbox provider does not support egress");
  });

  it("allows a capability it supports", () => {
    expect(() => requireCapability(providerWith({ pause: true }), "pause")).not.toThrow();
  });

  it("allows an unverified capability: it may still fail at the call", () => {
    expect(() => requireCapability(providerWith({ egress: "unverified" }), "egress")).not.toThrow();
  });

  it("does not second-guess a provider with no descriptor", () => {
    const bare = { id: "x" } as unknown as SandboxProvider;
    expect(() => requireCapability(bare, "snapshot")).not.toThrow();
  });

  it("treats a snapshot capability of { kind } as supported", () => {
    const provider = providerWith({ snapshot: { kind: "memory" } });
    expect(() => requireCapability(provider, "snapshot")).not.toThrow();
  });
});

describe("a provider that cannot, asked to", () => {
  it("checkpoint() is refused before any snapshot is requested", async () => {
    const provider = providerWith({ snapshot: false });
    const createSnapshot = vi.fn();
    provider.createSnapshot = createSnapshot;
    const sb = new SandboxHandle("sb-1", "t", { provider, adapter: adapter() });

    await expect(sb.checkpoint()).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      details: { capability: "snapshot" },
    });
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("pause() is refused before the provider is asked", async () => {
    const provider = providerWith({ pause: false });
    const pauseSandbox = vi.fn();
    provider.pauseSandbox = pauseSandbox;
    const sb = new SandboxHandle("sb-1", "t", { provider, adapter: adapter() });

    await expect(sb.pause()).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(pauseSandbox).not.toHaveBeenCalled();
  });

  it("fork() is refused before any snapshot is requested", async () => {
    const provider = providerWith({ snapshot: false });
    const createSnapshot = vi.fn();
    provider.createSnapshot = createSnapshot;
    const fork = vi.fn();
    const sb = new SandboxHandle("sb-1", "t", { provider, adapter: adapter(), fork });

    await expect(sb.fork()).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      details: { capability: "snapshot" },
    });
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it("resume() is refused before the provider is asked", async () => {
    const provider = providerWith({ pause: false });
    const resumeSandbox = vi.fn();
    provider.resumeSandbox = resumeSandbox;
    const sb = new SandboxHandle("sb-1", "t", { provider, adapter: adapter() });

    await expect(sb.resume()).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(resumeSandbox).not.toHaveBeenCalled();
  });

  it("an egress change is refused, naming egress", async () => {
    const provider = providerWith({ egress: false });
    const sb = new SandboxHandle("sb-1", "t", { provider, adapter: adapter() });

    await expect(
      sb.egress.patch([{ action: "allow", target: "example.com" }]),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      details: { capability: "egress" },
    });
  });
});
