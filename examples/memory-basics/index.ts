/**
 * Tour of `@alineo-labs/memory`'s standalone API — every capability the package ships,
 * one section at a time. Needs no OpenSandbox server, no API key, no network at all: the
 * "embedding provider" here is a tiny deterministic bag-of-words hash, good enough to
 * demonstrate that semantic ranking works, not a real embedding model. Swap it for
 * `createNvidiaEmbeddingProvider()` (`@alineo-labs/model-providers`) or any other
 * `EmbeddingProvider` for real semantic quality — the rest of this file is unaffected.
 *
 * Run:  cd examples/memory-basics && bun index.ts
 */
import { LedgerEvent } from "@alineo-labs/core";
import type { IStorageAdapter } from "@alineo-labs/core";
import {
  Memory,
  InMemoryWorkingMemoryProvider,
  InMemorySemanticMemoryProvider,
  SchemaWorkingMemory,
  episodicRecall,
  episodicTree,
  createMemoryTools,
  withTeamAccessControl,
} from "@alineo-labs/memory";
import type { EmbeddingProvider, ResourceRef, SchemaValidator } from "@alineo-labs/memory";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

const DIM = 32;

/** Deterministic "embedding" — a hashing-trick bag-of-words vector, zero infra required.
 *  Ranks by word overlap, not real semantic meaning — a toy, not a recommendation. */
function localBagOfWordsEmbeddings(): EmbeddingProvider {
  return {
    id: "local-bag-of-words-demo",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array(DIM).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let hash = 0;
          for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
          vector[hash % DIM] += 1;
        }
        return vector;
      });
    },
  };
}

const ref: ResourceRef = { resourceId: "user-42" };

// ── 1. Working memory ─────────────────────────────────────────────────────────
section("1. Working memory — required, structured key/value");

const memory = new Memory({
  workingMemory: new InMemoryWorkingMemoryProvider(),
  semantic: new InMemorySemanticMemoryProvider(localBagOfWordsEmbeddings()),
});

await memory.workingMemory.set(ref, "preferredLanguage", "TypeScript");
console.log("get:", await memory.workingMemory.get(ref, "preferredLanguage"));
console.log("list:", await memory.workingMemory.list(ref));

// ── 2. Semantic memory + verified facts ───────────────────────────────────────
section("2. Semantic memory — recall by meaning, and the verified flag");

await memory.remember(ref, { content: "user prefers dark mode" });
await memory.remember(ref, { content: "user asked about pricing tiers" });
// A fact tied to a real ledger entry (sandboxId + entryIndex) is computed as verified: true —
// never something the caller can just claim. See section 5 for where a real sourceRef comes from.
await memory.remember(ref, {
  content: "user confirmed the refund via support chat",
  sourceRef: { sandboxId: "sb-demo-1", entryIndex: 3 },
});

const recalled = await memory.recall(ref, "what does the user prefer for the UI?", { topK: 2 });
for (const fact of recalled) {
  console.log(`- "${fact.content}" (verified: ${fact.verified})`);
}

// ── 3. Compaction — age/count pruning, or LLM-style summarization ────────────
section("3. Compaction — prune old facts, or consolidate them");

for (let i = 0; i < 5; i++) {
  await memory.remember(ref, { content: `support ticket #${i} was resolved` });
}
console.log("facts before compaction:", (await memory.recall(ref, "ticket", { topK: 50 })).length);

const compacted = await memory.compactSemanticMemory(ref, {
  maxFacts: 3,
  // Real usage: pass an LLM call here ("summarize these into one fact"). This demo just
  // concatenates, to show the shape without needing a model.
  summarize: async (facts) => [`Summary of ${facts.length} old tickets: all resolved.`],
});
console.log("compaction result:", compacted);

// ── 4. Structured, schema'd working memory ───────────────────────────────────
section("4. SchemaWorkingMemory — validated, typed profiles");

interface Profile {
  name?: string;
  plan?: "free" | "pro";
}
const validator: SchemaValidator<Profile> = {
  parse(data) {
    const obj = data as Record<string, unknown>;
    if (obj.plan !== undefined && obj.plan !== "free" && obj.plan !== "pro") {
      throw new Error(`invalid plan: ${String(obj.plan)}`);
    }
    return obj as Profile;
  },
};
const profile = new SchemaWorkingMemory(new InMemoryWorkingMemoryProvider(), validator);
await profile.update(ref, { name: "Ada" });
await profile.update(ref, { plan: "pro" });
console.log("profile:", await profile.get(ref));

// ── 5. Episodic memory — a read API over the ledger, no new storage ──────────
section("5. Episodic memory — reads the sandbox ledger, reshaped by resourceId");

// A plain IStorageAdapter, populated by hand here to stand in for what real sandbox
// sessions (client.sandbox({ resourceId: ... })) already write automatically.
const adapter: IStorageAdapter = new SQLiteAdapter(":memory:");
await adapter.connect?.();

async function fakeSession(sandboxId: string, name: string, parentSandboxId?: string) {
  await adapter.append({
    ts: Date.now(),
    name,
    sandboxId,
    stepIndex: -1,
    event: LedgerEvent.SandboxCreated,
    payload: { sandboxId, runId: crypto.randomUUID(), resourceId: ref.resourceId, parentSandboxId },
  });
  await adapter.append({
    ts: Date.now() + 1,
    name,
    sandboxId,
    stepIndex: 0,
    event: LedgerEvent.ExecComplete,
    payload: { seq: 0, exitCode: 0 },
  });
}

await fakeSession("sb-demo-1", "session-1");
await fakeSession("sb-demo-2", "session-1-fork-a", "sb-demo-1"); // forked from sb-demo-1
await fakeSession("sb-demo-3", "session-1-fork-b", "sb-demo-1"); // a sibling fork

const flat = await episodicRecall(adapter, ref, { branch: "lineage" });
console.log(`episodicRecall (lineage): ${flat.length} entries across the fork chain`);

// ── 6. Branch-true episodic memory ────────────────────────────────────────────
section("6. episodicTree — the real fork tree, not a flattened stream");

const [root] = await episodicTree(adapter, ref);
console.log(`root session: ${root?.sandboxId} (${root?.entries.length} entries)`);
for (const child of root?.children ?? []) {
  console.log(`  ├─ fork ${child.sandboxId} (${child.entries.length} entries)`);
}

// ── 7. Forkable memory ────────────────────────────────────────────────────────
section("7. Memory.fork() — an independent, mutable copy of a resource's memory");

const forkResult = await memory.fork(ref, "user-42-child");
console.log("fork result:", forkResult);
await memory.workingMemory.set(forkResult.ref, "note", "only visible to the child");
console.log("parent still has no such key:", await memory.workingMemory.get(ref, "note"));

// ── 8. Team access control ────────────────────────────────────────────────────
section("8. withTeamAccessControl — app-layer teamId enforcement for any backend");

const teamRef: ResourceRef = { resourceId: "user-42", teamId: "team-alpha" };
const guarded = withTeamAccessControl(new InMemoryWorkingMemoryProvider(), {
  canAccess: (teamId) => teamId === "team-alpha", // in real use: check the current caller's claims
});
await guarded.set(teamRef, "key", "value");
console.log("allowed team:", await guarded.get(teamRef, "key"));
try {
  await guarded.get({ resourceId: "user-42", teamId: "team-beta" }, "key");
} catch (err) {
  console.log("denied team:", (err as Error).message);
}

// ── 9. Agent-callable memory tools ────────────────────────────────────────────
section("9. createMemoryTools — tool definitions a model can call itself");

const tools = createMemoryTools(memory, ref);
console.log(
  "tools:",
  tools.map((t) => t.name),
);
const rememberTool = tools.find((t) => t.name === "remember_fact")!;
await rememberTool.execute({ content: "remembered via a tool call, not a direct API call" });
console.log("last fact:", (await memory.recall(ref, "tool call", { topK: 1 }))[0]?.content);

console.log("\nDone — see the README for what a production wiring of this looks like.");
