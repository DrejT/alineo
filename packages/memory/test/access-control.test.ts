import { describe, expect, it } from "vitest";
import {
  MemoryAccessDeniedError,
  withTeamAccessControl,
  withTeamAccessControlSemantic,
} from "../src/access-control.ts";
import type { TeamAccessChecker } from "../src/access-control.ts";
import { isPrunable, InMemorySemanticMemoryProvider } from "../src/semantic.ts";
import type { EmbeddingProvider } from "../src/semantic.ts";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";

function fakeEmbeddings(): EmbeddingProvider {
  return {
    id: "fake",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };
}

function allowOnly(allowed: string[]): TeamAccessChecker {
  return { canAccess: (teamId) => allowed.includes(teamId) };
}

describe("withTeamAccessControl (working memory)", () => {
  it("passes through refs with no teamId untouched", async () => {
    const provider = withTeamAccessControl(new InMemoryWorkingMemoryProvider(), allowOnly([]));
    const ref = { resourceId: "user-1" };

    await provider.set(ref, "key", "value");

    expect(await provider.get(ref, "key")).toBe("value");
  });

  it("allows access to a teamId the checker approves", async () => {
    const provider = withTeamAccessControl(
      new InMemoryWorkingMemoryProvider(),
      allowOnly(["team-a"]),
    );
    const ref = { resourceId: "user-1", teamId: "team-a" };

    await provider.set(ref, "key", "value");

    expect(await provider.get(ref, "key")).toBe("value");
  });

  it("denies get/set/list/delete for a teamId the checker rejects", async () => {
    const provider = withTeamAccessControl(
      new InMemoryWorkingMemoryProvider(),
      allowOnly(["team-a"]),
    );
    const ref = { resourceId: "user-1", teamId: "team-b" };

    await expect(provider.get(ref, "key")).rejects.toThrow(MemoryAccessDeniedError);
    await expect(provider.set(ref, "key", "value")).rejects.toThrow(MemoryAccessDeniedError);
    await expect(provider.list(ref)).rejects.toThrow(MemoryAccessDeniedError);
    await expect(provider.delete(ref, "key")).rejects.toThrow(MemoryAccessDeniedError);
  });

  it("never reaches the wrapped provider on a denied call", async () => {
    const inner = new InMemoryWorkingMemoryProvider();
    const provider = withTeamAccessControl(inner, allowOnly([]));
    const ref = { resourceId: "user-1", teamId: "team-b" };

    await expect(provider.set(ref, "key", "value")).rejects.toThrow(MemoryAccessDeniedError);

    // Confirm the write never actually landed — checked directly against the inner provider.
    expect(await inner.get(ref, "key")).toBeUndefined();
  });

  it("MemoryAccessDeniedError carries the denied teamId", async () => {
    const provider = withTeamAccessControl(new InMemoryWorkingMemoryProvider(), allowOnly([]));

    const error: unknown = await provider
      .get({ resourceId: "user-1", teamId: "secret-team" }, "key")
      .catch((e) => e);

    expect(error).toBeInstanceOf(MemoryAccessDeniedError);
    expect((error as MemoryAccessDeniedError).teamId).toBe("secret-team");
  });
});

describe("withTeamAccessControlSemantic", () => {
  it("denies remember/recall for a rejected teamId", async () => {
    const provider = withTeamAccessControlSemantic(
      new InMemorySemanticMemoryProvider(fakeEmbeddings()),
      allowOnly([]),
    );
    const ref = { resourceId: "user-1", teamId: "team-b" };

    await expect(provider.remember(ref, { content: "fact" })).rejects.toThrow(
      MemoryAccessDeniedError,
    );
    await expect(provider.recall(ref, "query")).rejects.toThrow(MemoryAccessDeniedError);
  });

  it("allows and delegates for an approved teamId", async () => {
    const provider = withTeamAccessControlSemantic(
      new InMemorySemanticMemoryProvider(fakeEmbeddings()),
      allowOnly(["team-a"]),
    );
    const ref = { resourceId: "user-1", teamId: "team-a" };

    await provider.remember(ref, { content: "the sky is blue" });
    const results = await provider.recall(ref, "sky");

    expect(results[0]?.content).toBe("the sky is blue");
  });

  it("preserves the pruning capability of the wrapped provider", async () => {
    const provider = withTeamAccessControlSemantic(
      new InMemorySemanticMemoryProvider(fakeEmbeddings()),
      allowOnly(["team-a"]),
    );

    expect(isPrunable(provider)).toBe(true);
  });

  it("does not add a pruning capability the wrapped provider lacks", async () => {
    const notPrunable = { remember: async () => {}, recall: async () => [] };
    const provider = withTeamAccessControlSemantic(notPrunable, allowOnly(["team-a"]));

    expect(isPrunable(provider)).toBe(false);
  });

  it("enforces access on listAll/forget when the wrapped provider is prunable", async () => {
    const inner = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    const provider = withTeamAccessControlSemantic(inner, allowOnly([])) as typeof inner;
    const ref = { resourceId: "user-1", teamId: "team-b" };

    await expect(provider.listAll(ref)).rejects.toThrow(MemoryAccessDeniedError);
    await expect(provider.forget(ref, ["some-id"])).rejects.toThrow(MemoryAccessDeniedError);
  });
});
