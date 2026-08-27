/**
 * Recipe: a support agent that remembers things about a customer across sessions — not
 * within one conversation (Pi already keeps that), but across separate sandbox sessions
 * entirely, days apart, using `@alineo-labs/memory` backed by a real, persisted SQLite file.
 *
 * Needs a running OpenSandbox server (`alineo init`) and NVIDIA_API_KEY in the environment —
 * the agent config uses the NVIDIA NIM API (free tier available), and this recipe also calls
 * NVIDIA's embeddings endpoint directly for semantic recall (see `nvidiaEmbeddings()` below —
 * inlined rather than imported from `@alineo-labs/model-providers`, since that package is
 * private/internal to this repo's dashboard app, not meant to be depended on from outside it).
 */
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { Memory, buildContextSnippet } from "@alineo-labs/memory";
import type { EmbeddingProvider } from "@alineo-labs/memory";
import {
  SQLiteWorkingMemoryProvider,
  SQLiteSemanticMemoryProvider,
} from "@alineo-labs/sqlite-memory";

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

/**
 * A real embedding call against NVIDIA NIM's OpenAI-compatible endpoint — the same API the
 * agent spec below already needs a key for, so this recipe needs no second credential.
 *
 * `opts.type` matters here: NIM's embedding models are asymmetric, and `@alineo-labs/memory`'s
 * `remember()`/`recall()` call `embed()` with `{type: "passage"}`/`{type: "query"}`
 * respectively — hardcoding `input_type` to one value regardless of `opts.type` (an earlier
 * version of this recipe did exactly that) silently degrades recall relevance rather than
 * erroring, since a wrong-but-valid `input_type` still returns a vector, just a worse-ranked
 * one for the intent it was actually used for.
 */
function nvidiaEmbeddings(): EmbeddingProvider {
  return {
    id: "nvidia-embed",
    async embed(texts, opts) {
      const res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: "nvidia/nv-embedqa-e5-v5",
          input_type: opts?.type ?? "query",
        }),
      });
      if (!res.ok) throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

// One file, surviving this script's exit — a real process restart would find the same data
// here. That persistence is the entire point of this recipe.
const memory = new Memory({
  workingMemory: new SQLiteWorkingMemoryProvider("./.alineo/agent-memory.db"),
  semantic: new SQLiteSemanticMemoryProvider("./.alineo/agent-memory.db", nvidiaEmbeddings()),
});

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const spec = await Bun.file("./agents/support-agent.json").json();

// ── Session 1 — a customer's first conversation ────────────────────────────────
section("Session 1 — first contact");

let agent = await Alineo.load(spec, { adapter, memory });
console.log(`sandbox: ${agent.sandboxId}  |  resourceRef: ${JSON.stringify(agent.resourceRef)}`);

await agent.sandbox.exec("mkdir -p /workspace");
await agent.memory!.workingMemory.set(agent.resourceRef, "plan", "pro");
await agent.memory!.workingMemory.set(agent.resourceRef, "name", "Ada");

// Tie the fact to the ledger entry the exec below actually produces — reading the real
// index back afterward, not guessing one, so `verified` means what it claims to.
await agent.sandbox.exec("echo 'customer reported a billing issue'").pipe(process.stdout);
const entries = await adapter.readAll(agent.name, agent.sandboxId);
await agent.memory!.remember(agent.resourceRef, {
  content: "customer reported a billing issue and was told a refund was in progress",
  sourceRef: { sandboxId: agent.sandboxId, entryIndex: entries.length - 1 },
});

for await (const chunk of textOnly(agent.prompt("What plan is this customer on?"))) {
  process.stdout.write(chunk);
}
console.log("\n");

await agent.close();
console.log("(session 1 ended — sandbox closed, memory file remains)");

// ── Session 2 — a new sandbox, days later, same customer ───────────────────────
section("Session 2 — same customer, brand-new sandbox");

agent = await Alineo.load(spec, { adapter, memory });
console.log(`sandbox: ${agent.sandboxId}  (different from session 1's)`);

// Nothing about this sandbox knows anything yet — everything below comes back purely because
// `agent.resourceRef` (= this agent's spec `name`) is the same resource as session 1's.
console.log("working memory:", await agent.memory!.workingMemory.list(agent.resourceRef));
const recalled = await agent.memory!.recall(agent.resourceRef, "billing", { topK: 3 });
for (const fact of recalled) {
  console.log(`- "${fact.content}" (verified: ${fact.verified})`);
}

const context = await buildContextSnippet(agent.memory!, agent.resourceRef, {
  query: "what does this customer need help with?",
});
console.log("\n--- context assembled for the prompt ---\n" + context + "\n");

for await (const chunk of textOnly(
  agent.prompt(`${context}\n\nCustomer says: "Hi, following up on my refund."`),
)) {
  process.stdout.write(chunk);
}
console.log("\n");

await agent.close();
