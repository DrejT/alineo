import { LedgerEvent, SandboxStatus } from "@alineo-labs/core";
import type { IStorageAdapter, LedgerEntry, SandboxDetails } from "@alineo-labs/core";
import { describe, expect, it, vi } from "vitest";
import { episodicTree } from "../src/episodic-tree.ts";

function entry(overrides: Partial<LedgerEntry> & { ts: number; sandboxId: string }): LedgerEntry {
  return { name: "root", stepIndex: -1, event: LedgerEvent.SandboxCreated, ...overrides };
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

describe("episodicTree", () => {
  it("returns a single root with no children for one unforked session", async () => {
    const adapter = makeAdapter({
      details: [detail({ sandboxId: "sb-root", name: "root", resourceId: "user-1" })],
      entriesBySandboxId: { "sb-root": [entry({ ts: 1, sandboxId: "sb-root" })] },
    });

    const tree = await episodicTree(adapter, { resourceId: "user-1" });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.sandboxId).toBe("sb-root");
    expect(tree[0]?.parentSandboxId).toBeUndefined();
    expect(tree[0]?.children).toEqual([]);
  });

  it("nests a forked session under its parent", async () => {
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

    const tree = await episodicTree(adapter, { resourceId: "user-1" });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.sandboxId).toBe("sb-root");
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.sandboxId).toBe("sb-fork");
    expect(tree[0]?.children[0]?.parentSandboxId).toBe("sb-root");
  });

  it("distinguishes sibling branches forked from the same parent", async () => {
    const adapter = makeAdapter({
      details: [
        detail({ sandboxId: "sb-root", name: "root", resourceId: "user-1" }),
        detail({
          sandboxId: "sb-fork-a",
          name: "fork-a",
          resourceId: "user-1",
          parentSandboxId: "sb-root",
        }),
        detail({
          sandboxId: "sb-fork-b",
          name: "fork-b",
          resourceId: "user-1",
          parentSandboxId: "sb-root",
        }),
      ],
      entriesBySandboxId: {
        "sb-root": [entry({ ts: 1, sandboxId: "sb-root", name: "root" })],
        "sb-fork-a": [entry({ ts: 10, sandboxId: "sb-fork-a", name: "fork-a" })],
        "sb-fork-b": [entry({ ts: 20, sandboxId: "sb-fork-b", name: "fork-b" })],
      },
    });

    const tree = await episodicTree(adapter, { resourceId: "user-1" });

    expect(tree[0]?.children.map((c) => c.sandboxId)).toEqual(["sb-fork-a", "sb-fork-b"]);
    // Each branch's own entries stay its own — not merged with its sibling's.
    expect(tree[0]?.children[0]?.entries).toHaveLength(1);
    expect(tree[0]?.children[1]?.entries).toHaveLength(1);
  });

  it("brings in an unresolved ancestor so the tree has a coherent root", async () => {
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
        "sb-root": [entry({ ts: 1, sandboxId: "sb-root", name: "root" })],
        "sb-fork": [entry({ ts: 2, sandboxId: "sb-fork", name: "fork-root" })],
      },
    });

    // Only the fork is directly resolved — the tree must still surface its ancestor as a root.
    const tree = await episodicTree(
      adapter,
      { resourceId: "user-1" },
      { resolveSessions: async () => [{ name: "fork-root", sandboxId: "sb-fork" }] },
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.sandboxId).toBe("sb-root");
    expect(tree[0]?.children[0]?.sandboxId).toBe("sb-fork");
  });

  it("returns an empty array when no session matches", async () => {
    const adapter = makeAdapter({ details: [], entriesBySandboxId: {} });

    expect(await episodicTree(adapter, { resourceId: "nobody" })).toEqual([]);
  });

  it("clears parentSandboxId for a root whose recorded parent wasn't resolved into the tree", async () => {
    const adapter = makeAdapter({
      details: [
        detail({
          sandboxId: "sb-fork",
          name: "fork-root",
          resourceId: "user-1",
          // The parent's own ledger record no longer exists (deleted) — not just "not
          // walked to" by withAncestors, genuinely absent from listAllSandboxDetails().
          parentSandboxId: "sb-deleted",
        }),
      ],
      entriesBySandboxId: {
        "sb-fork": [entry({ ts: 1, sandboxId: "sb-fork", name: "fork-root" })],
      },
    });

    const tree = await episodicTree(adapter, { resourceId: "user-1" });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.sandboxId).toBe("sb-fork");
    // Before the fix, this stayed "sb-deleted" even though the branch landed in `roots` —
    // contradicting parentSandboxId's own documented "absent for a root" contract.
    expect(tree[0]?.parentSandboxId).toBeUndefined();
  });

  it("does not merge two teams' sessions that happen to share a resourceId", async () => {
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
        "sb-acme": [entry({ ts: 1, sandboxId: "sb-acme", name: "support-bot" })],
        "sb-globex": [entry({ ts: 2, sandboxId: "sb-globex", name: "support-bot" })],
      },
    });

    const tree = await episodicTree(adapter, { resourceId: "support-bot", teamId: "acme" });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.sandboxId).toBe("sb-acme");
  });
});
