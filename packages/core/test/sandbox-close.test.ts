import { describe, expect, it, vi } from "vitest";
import { SandboxHandle } from "../src/sandbox/index.ts";
import type { SandboxDeps } from "../src/sandbox/index.ts";
import type { IStorageAdapter } from "../src/ledger.ts";

function makeAdapter(): IStorageAdapter {
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

function makeControl() {
  return { deleteSandbox: vi.fn().mockResolvedValue(undefined) };
}

function asControl(control: ReturnType<typeof makeControl>): SandboxDeps["control"] {
  return control as unknown as SandboxDeps["control"];
}

function makeDeps(adapter: IStorageAdapter): SandboxDeps {
  return {
    control: asControl(makeControl()),
    adapter,
  };
}

interface SandboxTestInternals {
  _execClient: unknown;
}

/** SandboxCore._execClient is private; this reaches it for tests that need to inject a fake. */
function setExecClient(sb: SandboxHandle, client: unknown): void {
  (sb as unknown as SandboxTestInternals)._execClient = client;
}

describe("SandboxHandle.close()", () => {
  it("disposes any resolved exec client's dangling connections (regression for #21 Bug A)", async () => {
    const sb = new SandboxHandle("sb-1", "test", makeDeps(makeAdapter()));
    const fakeExecClient = { disposeConnections: vi.fn() };
    // Simulates a client already resolved by a prior exec() call — exercised directly
    // rather than via a real exec() round-trip, matching how sibling tests in this file
    // poke at private sandbox state (e.g. sandbox-interactive.test.ts's openSessionClosers).
    setExecClient(sb, fakeExecClient);

    await sb.close();

    expect(fakeExecClient.disposeConnections).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a new exec client just to dispose it when none was ever created", async () => {
    const adapter = makeAdapter();
    const control = makeControl();
    const sb = new SandboxHandle("sb-1", "test", { control: asControl(control), adapter });

    await expect(sb.close()).resolves.toBeUndefined();
    // No fetch/control call was ever made to resolve an exec client — deleteSandbox is
    // the only control-plane call close() should have needed.
    expect(control.deleteSandbox).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second close() does not dispose the exec client again", async () => {
    const sb = new SandboxHandle("sb-1", "test", makeDeps(makeAdapter()));
    const fakeExecClient = { disposeConnections: vi.fn() };
    setExecClient(sb, fakeExecClient);

    await sb.close();
    await sb.close();

    expect(fakeExecClient.disposeConnections).toHaveBeenCalledTimes(1);
  });
});
