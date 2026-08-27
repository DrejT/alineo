import { describe, expect, it, vi } from "vitest";
import { SandboxHandle } from "../src/sandbox/index.ts";
import { LedgerEvent } from "../src/ledger.ts";
import type { SandboxDeps } from "../src/sandbox/index.ts";
import type { IStorageAdapter, LedgerEntry } from "../src/ledger.ts";

function makeAdapter(): IStorageAdapter {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue([]),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(adapter: IStorageAdapter): SandboxDeps {
  return { control: {} as unknown as SandboxDeps["control"], adapter };
}

describe("SandboxHandle — ledger write ordering (emit queue)", () => {
  it("does not invoke a later append() until an earlier, slower one resolves", async () => {
    const adapter = makeAdapter();
    const appendOrder: string[] = [];
    let resolveSlow: (() => void) | undefined;

    vi.mocked(adapter.append).mockImplementation((entry: LedgerEntry) => {
      const id = (entry.payload as { id: string }).id;
      if (id === "slow") {
        return new Promise<void>((resolve) => {
          resolveSlow = () => {
            appendOrder.push("slow");
            resolve();
          };
        });
      }
      appendOrder.push(id);
      return Promise.resolve();
    });

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));

    const p1 = sb.emit(LedgerEvent.ExecEvent, -1, { id: "slow" });
    const p2 = sb.emit(LedgerEvent.ExecEvent, -1, { id: "fast" });

    await new Promise((r) => setTimeout(r, 20));
    // The "fast" append must not be invoked before "slow" resolves, even though
    // append() itself would resolve instantly if it were called.
    expect(adapter.append).toHaveBeenCalledTimes(1);
    expect(appendOrder).toEqual([]);

    resolveSlow?.();
    await Promise.all([p1, p2]);

    expect(appendOrder).toEqual(["slow", "fast"]);
  });

  it("keeps writing after a failed append — the failure only surfaces to that call's own caller", async () => {
    const adapter = makeAdapter();
    vi.mocked(adapter.append)
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));

    await expect(sb.emit(LedgerEvent.ExecEvent, -1, {})).rejects.toThrow("write failed");
    await expect(sb.emit(LedgerEvent.ExecEvent, -1, {})).resolves.toBeUndefined();
    expect(adapter.append).toHaveBeenCalledTimes(2);
  });

  it("captures ts at call time, not at write time", async () => {
    const adapter = makeAdapter();
    let resolveSlow: (() => void) | undefined;
    vi.mocked(adapter.append).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSlow = resolve;
        }),
    );

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const before = Date.now();
    void sb.emit(LedgerEvent.ExecEvent, -1, {});

    await vi.waitFor(() => {
      expect(adapter.append).toHaveBeenCalledTimes(1);
    });
    // TS's array indexing types this as always-defined; widen it so the guard below
    // (real if append() is never called) is meaningful instead of dead code to the checker.
    const entryAtCallTime = vi.mocked(adapter.append).mock.calls[0]?.[0] as LedgerEntry | undefined;
    if (!entryAtCallTime) throw new Error("expected append() to have been called");

    await new Promise((r) => setTimeout(r, 50));
    resolveSlow?.();

    expect(entryAtCallTime.ts).toBeGreaterThanOrEqual(before);
    expect(entryAtCallTime.ts).toBeLessThan(before + 50);
  });
});
