import { LedgerEvent, SandboxStatus } from "@alineo-labs/core";
import type { IStorageAdapter, LedgerEntry, SandboxDetails } from "@alineo-labs/core";
import { describe, expect, it, vi } from "vitest";
import { episodicRecall } from "../src/episodic.ts";

function entry(overrides: Partial<LedgerEntry> & { ts: number; sandboxId: string }): LedgerEntry {
  return {
    name: "user-1",
    stepIndex: -1,
    event: LedgerEvent.SandboxCreated,
    ...overrides,
  };
}

function makeAdapter(opts: {
  details: SandboxDetails[];
  entriesBySandboxId: Record<string, LedgerEntry[]>;
}): IStorageAdapter {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn(
      async (_name: string, sandboxId: string) => opts.entriesBySandboxId[sandboxId] ?? [],
    ),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue(opts.details),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
  };
}

function detail(
  overrides: Partial<SandboxDetails> & { sandboxId: string; name: string },
): SandboxDetails {
  return {
    status: SandboxStatus.Completed,
    startedAt: 0,
    execCount: 0,
    runId: "run-1",
    ...overrides,
  };
}

describe("episodicRecall", () => {
  it("merges and time-orders entries across every session named after the resourceId", async () => {
    const adapter = makeAdapter({
      details: [
        detail({ sandboxId: "sb-1", name: "user-1" }),
        detail({ sandboxId: "sb-2", name: "user-1" }),
        detail({ sandboxId: "sb-other", name: "someone-else" }),
      ],
      entriesBySandboxId: {
        "sb-1": [entry({ ts: 100, sandboxId: "sb-1" })],
        "sb-2": [entry({ ts: 50, sandboxId: "sb-2" })],
        "sb-other": [entry({ ts: 25, sandboxId: "sb-other", name: "someone-else" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" });

    expect(result.map((e) => e.sandboxId)).toEqual(["sb-2", "sb-1"]);
  });

  it("returns an empty array when no session matches the resourceId", async () => {
    const adapter = makeAdapter({ details: [], entriesBySandboxId: {} });

    expect(await episodicRecall(adapter, { resourceId: "nobody" })).toEqual([]);
  });

  it("respects limit by keeping only the most recent N entries", async () => {
    const adapter = makeAdapter({
      details: [detail({ sandboxId: "sb-1", name: "user-1" })],
      entriesBySandboxId: {
        "sb-1": [
          entry({ ts: 1, sandboxId: "sb-1" }),
          entry({ ts: 2, sandboxId: "sb-1" }),
          entry({ ts: 3, sandboxId: "sb-1" }),
        ],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" }, { limit: 2 });

    expect(result.map((e) => e.ts)).toEqual([2, 3]);
  });

  it("uses a custom resolveSessions when supplied instead of the name-based default", async () => {
    const adapter = makeAdapter({
      details: [],
      entriesBySandboxId: { "sb-custom": [entry({ ts: 1, sandboxId: "sb-custom" })] },
    });

    const result = await episodicRecall(
      adapter,
      { resourceId: "whatever" },
      { resolveSessions: async () => [{ name: "user-1", sandboxId: "sb-custom" }] },
    );

    expect(result).toHaveLength(1);
  });
});
