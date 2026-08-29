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
  it("merges and time-orders entries across every session tagged with the resourceId", async () => {
    const adapter = makeAdapter({
      details: [
        detail({ sandboxId: "sb-1", name: "session-a", resourceId: "user-1" }),
        detail({ sandboxId: "sb-2", name: "session-b", resourceId: "user-1" }),
        detail({ sandboxId: "sb-other", name: "someone-else", resourceId: "user-2" }),
      ],
      entriesBySandboxId: {
        "sb-1": [entry({ ts: 100, sandboxId: "sb-1", name: "session-a" })],
        "sb-2": [entry({ ts: 50, sandboxId: "sb-2", name: "session-b" })],
        "sb-other": [entry({ ts: 25, sandboxId: "sb-other", name: "someone-else" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" });

    expect(result.map((e) => e.sandboxId)).toEqual(["sb-2", "sb-1"]);
  });

  it("falls back to matching name against resourceId when resourceId was never recorded", async () => {
    const adapter = makeAdapter({
      details: [
        detail({ sandboxId: "sb-1", name: "user-1" }), // no resourceId — pre-migration data
        detail({ sandboxId: "sb-other", name: "someone-else" }),
      ],
      entriesBySandboxId: {
        "sb-1": [entry({ ts: 100, sandboxId: "sb-1" })],
        "sb-other": [entry({ ts: 25, sandboxId: "sb-other", name: "someone-else" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" });

    expect(result.map((e) => e.sandboxId)).toEqual(["sb-1"]);
  });

  it("returns an empty array when no session matches the resourceId", async () => {
    const adapter = makeAdapter({ details: [], entriesBySandboxId: {} });

    expect(await episodicRecall(adapter, { resourceId: "nobody" })).toEqual([]);
  });

  it("does not merge two teams' sessions that happen to share a resourceId", async () => {
    // The exact collision this exists to prevent — e.g. two teams both naming an agent
    // "support-bot", the default `Alineo.resourceRef` convention.
    const adapter = makeAdapter({
      details: [
        detail({
          sandboxId: "sb-acme",
          name: "support-bot",
          resourceId: "support-bot",
          teamId: "acme",
        }),
        detail({
          sandboxId: "sb-globex",
          name: "support-bot",
          resourceId: "support-bot",
          teamId: "globex",
        }),
      ],
      entriesBySandboxId: {
        "sb-acme": [entry({ ts: 100, sandboxId: "sb-acme", name: "support-bot" })],
        "sb-globex": [entry({ ts: 200, sandboxId: "sb-globex", name: "support-bot" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "support-bot", teamId: "acme" });

    expect(result.map((e) => e.sandboxId)).toEqual(["sb-acme"]);
  });

  it("matches an untenanted ref (no teamId) only against untenanted sessions", async () => {
    const adapter = makeAdapter({
      details: [
        detail({ sandboxId: "sb-plain", name: "user-1", resourceId: "user-1" }),
        detail({ sandboxId: "sb-tenanted", name: "user-1", resourceId: "user-1", teamId: "acme" }),
      ],
      entriesBySandboxId: {
        "sb-plain": [entry({ ts: 100, sandboxId: "sb-plain" })],
        "sb-tenanted": [entry({ ts: 200, sandboxId: "sb-tenanted" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" });

    expect(result.map((e) => e.sandboxId)).toEqual(["sb-plain"]);
  });

  it("does not match a legacy (pre-teamId) session for a team-scoped caller", async () => {
    // Conservative by design, not an oversight — see resolveSessionsByResourceId's own doc
    // comment: a session with no recorded teamId isn't assumed to belong to any particular
    // team, so it becomes invisible to a team-scoped caller rather than risking a leak.
    const adapter = makeAdapter({
      details: [detail({ sandboxId: "sb-1", name: "user-1", resourceId: "user-1" })],
      entriesBySandboxId: { "sb-1": [entry({ ts: 100, sandboxId: "sb-1" })] },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1", teamId: "acme" });

    expect(result).toEqual([]);
  });

  it("respects limit by keeping only the most recent N entries", async () => {
    const adapter = makeAdapter({
      details: [detail({ sandboxId: "sb-1", name: "user-1", resourceId: "user-1" })],
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

  it("limit: 0 returns nothing, not everything", async () => {
    // `entries.slice(-0)` is `entries.slice(0)` — the whole array — so this needs its own
    // branch rather than falling into the general negative-index slice.
    const adapter = makeAdapter({
      details: [detail({ sandboxId: "sb-1", name: "user-1", resourceId: "user-1" })],
      entriesBySandboxId: {
        "sb-1": [entry({ ts: 1, sandboxId: "sb-1" }), entry({ ts: 2, sandboxId: "sb-1" })],
      },
    });

    const result = await episodicRecall(adapter, { resourceId: "user-1" }, { limit: 0 });

    expect(result).toEqual([]);
  });

  it("uses a custom resolveSessions when supplied instead of the default resolver", async () => {
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

  describe("branch: lineage", () => {
    it("includes ancestor sessions reachable via parentSandboxId", async () => {
      const adapter = makeAdapter({
        details: [
          detail({ sandboxId: "sb-root", name: "root", resourceId: "user-1" }),
          detail({
            sandboxId: "sb-fork",
            name: "fork-root",
            resourceId: "user-1",
            parentSandboxId: "sb-root",
          }),
        ],
        entriesBySandboxId: {
          "sb-root": [entry({ ts: 10, sandboxId: "sb-root", name: "root" })],
          "sb-fork": [entry({ ts: 20, sandboxId: "sb-fork", name: "fork-root" })],
        },
      });

      // Default resolver only returns sessions matching resourceId directly — both do here,
      // so simulate the common case of only the fork being "the" session of interest by
      // resolving just the fork, then let lineage walk back up to its parent.
      const result = await episodicRecall(
        adapter,
        { resourceId: "user-1" },
        {
          branch: "lineage",
          resolveSessions: async () => [{ name: "fork-root", sandboxId: "sb-fork" }],
        },
      );

      expect(result.map((e) => e.sandboxId).sort()).toEqual(["sb-fork", "sb-root"]);
    });

    it("stops at a session with no recorded parentSandboxId", async () => {
      const adapter = makeAdapter({
        details: [detail({ sandboxId: "sb-root", name: "root", resourceId: "user-1" })],
        entriesBySandboxId: {
          "sb-root": [entry({ ts: 10, sandboxId: "sb-root", name: "root" })],
        },
      });

      const result = await episodicRecall(adapter, { resourceId: "user-1" }, { branch: "lineage" });

      expect(result.map((e) => e.sandboxId)).toEqual(["sb-root"]);
    });

    it("does not walk lineage in the default 'flat' mode", async () => {
      const adapter = makeAdapter({
        details: [
          detail({ sandboxId: "sb-root", name: "root", resourceId: "user-1" }),
          detail({
            sandboxId: "sb-fork",
            name: "fork-root",
            resourceId: "user-1",
            parentSandboxId: "sb-root",
          }),
        ],
        entriesBySandboxId: {
          "sb-root": [entry({ ts: 10, sandboxId: "sb-root", name: "root" })],
          "sb-fork": [entry({ ts: 20, sandboxId: "sb-fork", name: "fork-root" })],
        },
      });

      const result = await episodicRecall(
        adapter,
        { resourceId: "user-1" },
        { resolveSessions: async () => [{ name: "fork-root", sandboxId: "sb-fork" }] },
      );

      expect(result.map((e) => e.sandboxId)).toEqual(["sb-fork"]);
    });
  });
});
