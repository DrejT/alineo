# Memory in alineo: exploration & proposal

**Status:** exploration / pre-RFC
**Scope:** how a memory layer could work in alineo, how that compares to Mastra, Flue,
LangChain/LangGraph, Vercel Eve, and Agno, and a concrete proposal for what alineo could build that
would be genuinely differentiated, cheap to run, and safe to hand to a team (not just a solo
developer with an API key).

---

## TL;DR

alineo has **no memory layer today**. It has three things that are memory-_adjacent_ — a durable
execution ledger, Pi's own in-session conversation history, and a sandbox filesystem — but nothing
that lets an agent recall a fact from last week, nothing shared across agents on a team, and nothing
semantic. Every competitor surveyed here (Mastra, LangGraph, Agno, and now Vercel's Eve) has shipped
some version of "working memory + long-term recall" as a first-class primitive. That's the gap.

The good news: alineo is unusually well positioned to close it _cheaply_, because the pieces already
exist and just haven't been pointed at this problem —

- **`IStorageAdapter`** already turns "durable, queryable event log" into a two-line integration
  (`SQLiteAdapter` locally, `PostgresAdapter` in prod). A memory store is the same shape of problem.
- **The ledger is already an audit trail.** Nobody else in this comparison ties memory _writes_ to a
  replayable, timestamped event log the way alineo's `LedgerEntry`/`IStorageAdapter` already does
  for execution. That's a real, defensible differentiator, not a marketing angle.
- **Checkpoint/resume already exists.** Tying memory state to sandbox snapshots means "resume this
  agent" can mean _exactly_ what it worked on, remembered, and believed — not just its filesystem.
- **No new vendor required.** Postgres + `pgvector` gives semantic recall on the same database the
  ledger already lives in. Teams already running `@alineo-labs/postgres` in production pay for
  memory with a `CREATE EXTENSION` statement, not a second SaaS bill.

Proposed shape: a new `@alineo-labs/memory` package, built as a sibling to
`@alineo-labs/workflow` and the storage adapters — see [§6](#6-the-proposal-alineo-labsmemory) for
the full design and [§8](#8-phased-roadmap) for a phased rollout starting from something shippable
in a week, not a quarter.

---

## 1. What "agent memory" actually means

Every framework surveyed converges on roughly the same taxonomy, even when the terminology differs.
Worth naming precisely before comparing implementations, because "alineo has no memory" and "alineo
has no _semantic_ memory" are different claims and the gap analysis in §5 depends on the distinction:

| Kind                               | Question it answers                               | Typical lifetime                                       | Typical storage                                                                 |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Working memory**                 | "What do I currently know about this user/task?"  | Session or resource-scoped, small (few hundred tokens) | Structured blob (JSON/Markdown), often injected straight into the system prompt |
| **Episodic / conversation memory** | "What happened in this conversation?"             | One thread                                             | Ordered message log                                                             |
| **Semantic / long-term memory**    | "What do I know that isn't in this conversation?" | Indefinite, cross-session                              | Vector store + metadata, retrieved by similarity                                |
| **Procedural memory**              | "How do I do this kind of task?"                  | Indefinite                                             | Prompts, learned tool-use patterns, skills                                      |
| **Shared / team memory**           | "What does _anyone on this team_ know?"           | Indefinite, cross-user                                 | Same as semantic, but scoped by org/team, not just by user                      |

alineo, today, has a strong (accidental) episodic store and nothing else.

---

## 2. Where alineo stands today

This section is grounded in the actual code, not a guess — three real subsystems currently do
memory-_adjacent_ work, and none of them is a memory API.

### 2.1 The ledger — durable, but it's an audit log, not a memory store

[`packages/core/src/ledger.ts`](../packages/core/src/ledger.ts) defines `IStorageAdapter`,
`LedgerEntry`, and `LedgerEvent`. Every `exec()`, checkpoint, and lifecycle transition is appended
as a `LedgerEntry { ts, name, sandboxId, stepIndex, event, payload }` and can be replayed via
`readAll(name, sandboxId)`. This is genuinely durable and genuinely queryable — but it's indexed by
`sandboxId`, not by user/resource/team, has no semantic retrieval, and its payloads are execution
records (`exec_start`, `checkpoint_created`, …), not facts an agent decided were worth remembering.
It's the right _shape_ of primitive (append-only, adapter-backed, replayable) pointed at the wrong
problem.

### 2.2 Pi's session state — real conversation memory, but ephemeral and unscoped

[`.agents/skills/alineo/rules/agent-sdk.md`](../.agents/skills/alineo/rules/agent-sdk.md) and
`packages/agent/src/agent/introspection.ts` show a real, fairly sophisticated in-session memory
story: `agent.getMessages()`, `agent.compact(instructions?)` / `setAutoCompaction()` for context
management, `agent.fork(entryId)` / `agent.clone()` for branching history, `agent.newSession()` to
reset. This is Pi's own conversation state, running inside the sandbox's bridge process. It answers
"what happened in _this_ conversation" well. It does not answer "what do we know that isn't in this
conversation" at all — there's no cross-session recall, no cross-agent sharing, and it disappears
with the sandbox unless the _whole container_ is checkpointed.

### 2.3 The sandbox filesystem — memory as a workaround, not an API

Nothing stops an agent from `writeFile("/workspace/memory.json", …)` and reading it back next
session via checkpoint/resume. Several of the [cookbooks](../cookbooks) in this repo do exactly this
pattern for state that needs to survive a stage boundary. It works, but it's per-sandbox, unindexed,
un-searchable, and invisible to any other agent or teammate — a filesystem, not a memory system.

### 2.4 What's missing, stated plainly

- No working-memory abstraction (no structured "what I know about this user" blob).
- No semantic recall (no embeddings, no vector store, no `packages/adapters/*` entry for one).
- No cross-session memory (close the sandbox, and Pi's history goes with it unless you checkpoint
  the whole container).
- No team/resource scoping (nothing like Mastra's `resourceId` or LangGraph's cross-thread `Store`).
- No memory lifecycle (no compaction/summarization of _facts_, only of conversation turns).

---

## 3. The comparative landscape

### 3.1 Mastra

Mastra (TypeScript, closest sibling to alineo in stack and philosophy) ships three memory
primitives directly on the `Agent`/`Memory` API:

- **Working memory** — persistent, structured user data (name, preferences, goals) as a Markdown
  block or Zod schema, updated by the agent over time and re-injected into the system prompt.
- **Semantic recall** — RAG over past messages: embeds messages, does vector similarity search
  against a configurable store, with a context window around each retrieved hit. Uses the AI SDK's
  model router, so embeddings are provider-agnostic.
- **Observational memory** (newer) — a background agent maintains a dense observation log that
  _replaces_ raw message history as a conversation grows, instead of just trimming/summarizing it.

Scoping is the interesting design choice: memory defaults to `scope: "resource"` — two agents
sharing a `resourceId` share observations, working memory, and embeddings _even across threads_.
That's Mastra's answer to team/shared memory, and it's a clean one. Storage is pluggable
(`@mastra/libsql` for quickstart, Postgres and others for production) — same adapter philosophy
alineo already has for the ledger.

### 3.2 LangChain / LangGraph

LangChain's older `ConversationBufferMemory`-style APIs are effectively deprecated in favor of
**LangGraph persistence**, which splits cleanly into two systems:

- **Checkpointer** — thread-scoped, short-term. Persists full graph state as checkpoints; powers
  conversation continuity, human-in-the-loop pauses, time-travel debugging, and crash recovery.
  Backends: `InMemorySaver` (dev), `SqliteSaver`, `PostgresSaver`/`AsyncPostgresSaver` (prod).
- **Store** (`BaseStore`) — cross-thread, long-term. Application-defined key-value/semantic data —
  user preferences, facts, shared knowledge — read/written by nodes independent of any one thread.

This is architecturally the closest thing to what's proposed in §6: a durable, replayable
short-term layer plus a separate long-term store, both adapter-backed. The tradeoff LangGraph teams
report in production: **checkpoints accumulate**. Every graph step writes a full state snapshot, so
long-running or high-volume threads need explicit retention/pruning policies (cron jobs, TTLs) or
storage and latency both grow unbounded. Thread IDs are capped at 255 characters on the Postgres
backend — a real constraint teams hit when composing IDs from route/tenant/user.

### 3.3 Agno (formerly Phidata)

Agno leans furthest into "memory as an agent capability, not just storage":

- **Session memory** — conversation history + state per session, on by default.
- **Agentic memory** — `enable_agentic_memory=True` lets the agent itself create, update, and delete
  memory records after each run, no separate memory-management code required. Default
  implementation is SQLite-backed.
- **Knowledge** (separate from memory) — Agentic RAG over a searchable knowledge base with pluggable
  vector stores (PgVector among them), retrieved on demand rather than stuffed into every prompt.

The "agent edits its own memory via tool calls" pattern is the same idea Letta/MemGPT popularized
(tiered context: small self-editable core memory + larger archival memory paged in via search). It's
powerful and a little dangerous unsupervised — self-editing memory needs the same audit trail an
agent's _actions_ need, and in Agno's default SQLite-backed implementation that audit trail doesn't
appear to be a first-class feature the way execution logging is elsewhere.

### 3.4 Flue

Flue (Astro team; alineo already ships `@alineo-labs/flue` as a runtime adapter, so this is a direct
neighbor, not just a competitor) is architecturally the _closest relative_ of anything surveyed here
— its session model is explicitly append-only: "each event in the execution history is added to an
append-only log... an agent's state is never volatile," conceptually the same shape as alineo's own
`LedgerEntry` stream. On Node, sessions default to in-memory storage unless a custom store is
provided; on Cloudflare, sessions are backed by Durable Objects. Flue treats memory as a durability
concern (survive a crash/redeploy) rather than a _recall_ concern — there's no semantic search or
long-term cross-session store described in its public materials. It validates the ledger-as-memory
instinct architecturally without actually solving retrieval.

### 3.5 Vercel Eve

Eve (released June 2026, Apache-2.0, TypeScript) is the newest and most structurally similar to
alineo of the five: filesystem-first agent definitions, sandboxed code execution, and — the
memory-relevant part — **every conversation is a durable workflow, checkpointed at each step**, so a
session can pause, survive a crash or redeploy, and resume exactly where it left off. That's
short-term durability done well, built the same way alineo's own checkpoint/resume works
conceptually (snapshot the state, restore it later). What's notably _not_ documented publicly (as of
this writing) is a semantic/long-term recall layer or cross-session/team memory — Eve currently reads
as "durable execution" rather than "memory," which, again, is exactly where alineo is today. Worth
tracking as it matures, but not a system to catch up to on memory specifically — the two projects
currently have the same gap.

### 3.6 Side-by-side

|                    | Working memory                | Semantic recall                     | Cross-thread/team            | Durable audit trail of memory itself                | Storage                                 | Infra lock-in         |
| ------------------ | ----------------------------- | ----------------------------------- | ---------------------------- | --------------------------------------------------- | --------------------------------------- | --------------------- |
| **Mastra**         | ✅ structured blob            | ✅ vector, provider-agnostic        | ✅ via `resourceId`          | ❌                                                  | LibSQL, Postgres, others                | Low                   |
| **LangGraph**      | ⚠️ via Store, not first-class | ⚠️ possible via Store, not built in | ✅ via `Store`               | ⚠️ checkpoints exist but need pruning               | Postgres, SQLite, in-memory             | Low                   |
| **Agno**           | ✅ agentic, self-editing      | ✅ via Knowledge/RAG                | ⚠️ session-scoped by default | ❌                                                  | SQLite default, PgVector for Knowledge  | Low                   |
| **Flue**           | ❌                            | ❌                                  | ❌                           | ✅ (execution ledger, not memory-specific)          | In-memory (Node) / Durable Objects (CF) | Medium (CF-flavored)  |
| **Eve**            | ❌ (not yet documented)       | ❌ (not yet documented)             | ❌ (not yet documented)      | ✅ (workflow checkpoints)                           | Vercel-backed durable workflows         | High (Vercel-centric) |
| **alineo (today)** | ❌                            | ❌                                  | ❌                           | ✅ (ledger, but execution-scoped not memory-scoped) | SQLite, Postgres                        | Low                   |

---

## 4. The cost reality teams are actually paying

This matters because "cost-effective" is a real, checkable claim, not a slogan. What teams pay
_today_ to bolt memory onto an agent stack:

| Option                           | Entry cost                                    | At meaningful scale (~10M vectors / production traffic)       |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| **Pinecone**                     | $50/mo minimum (Standard plan)                | ~$70–100+/mo serverless, plus $8.25/M reads, $2/M writes      |
| **Mem0**                         | Free tier: 10K memories / 1K retrievals/mo    | $19/mo → $249/mo (Pro, adds graph memory) → custom enterprise |
| **Zep**                          | $25/mo (Flex, full features)                  | ~$15 per million tokens processed                             |
| **Weaviate Cloud**               | $25/mo floor                                  | ~$135/mo                                                      |
| **Qdrant Cloud**                 | —                                             | ~$65/mo                                                       |
| **pgvector on managed Postgres** | Cost of the Postgres instance you already run | ~$45/mo _incremental_ over base Postgres                      |

The pattern: every dedicated memory vendor is a _new bill, new auth, new data-residency question,
new thing to keep in sync with your actual application state_. pgvector is the outlier because it
isn't a vendor — it's an extension on infrastructure teams already operate.

alineo teams running `@alineo-labs/postgres` in production are, structurally, one `CREATE EXTENSION
vector;` away from semantic recall with **zero new vendors, zero new bills, and zero new data-
residency surface** — the ledger and the memories live in the same database, under the same backup
policy, the same access controls, the same on-call runbook. That's not a nice-to-have; for a team
that already has to justify infra spend, it's the difference between "add a line to a migration" and
"file a new vendor security review."

---

## 5. Gap analysis: what alineo would need to not be behind

Ranked by leverage — cheapest to build relative to how much of the gap it closes:

1. **Working memory** — currently zero. A structured, adapter-backed key-value/JSON store scoped by
   resource (user/team/agent), injected into agent prompts. This is the _smallest_ build (one table,
   one adapter method) and closes the single most commonly used memory feature across every
   competitor surveyed.
2. **Cross-session episodic recall** — currently trapped inside Pi's in-sandbox session. A read API
   over the existing ledger, reshaped by resource instead of by `sandboxId`, gets most of the way
   there without touching the execution ledger's schema.
3. **Semantic recall** — currently zero. Needs an embeddings table + pluggable embedding provider
   (reuse `@alineo-labs/model-providers`'s registry pattern) + pgvector (Postgres) / sqlite-vec
   (SQLite) similarity search.
4. **Team/shared memory** — currently zero. A scoping key (`teamId`/`resourceId`) on the above two,
   plus (Postgres only) row-level security so multi-tenant teams don't need application-layer
   filtering to stay safe.
5. **Memory audit trail** — currently zero _as a memory concept_, though the ledger pattern to build
   it from already exists and is proven in production for execution events.

None of these require a new runtime, a new language, or a new vendor. All five are extensions of
patterns (`IStorageAdapter`, ledger events, adapter pluggability) that already ship and are already
battle-tested by every sandbox/exec call in the SDK.

---

## 6. The proposal: `@alineo-labs/memory`

A new package, structured the same way `@alineo-labs/workflow` sits next to `packages/core` — a thin
layer over the existing adapter/ledger primitives, not a parallel subsystem.

### 6.1 Memory model

| Tier                | Maps to                                  | Backing                                                                                                                                                                    |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working memory**  | "what we currently know"                 | New `alineo_working_memory` table: `(resource_id, key, value_json, updated_at)` — one row per fact, cheap upserts                                                          |
| **Episodic memory** | "what happened"                          | The _existing_ ledger, re-indexed by `resourceId` in addition to `sandboxId` — no new storage, just a new read path                                                        |
| **Semantic memory** | "what we know that isn't in front of us" | New `alineo_memories` table: `(resource_id, team_id, content, embedding, source_ref, created_at)`, `vector` column via pgvector (Postgres) or a BLOB + sqlite-vec (SQLite) |
| **Team memory**     | semantic memory, scoped wider            | Same table, `team_id` scoping + Postgres RLS policy so cross-tenant leakage is a database guarantee, not an application promise                                            |

### 6.2 Schema sketch (Postgres — mirrors the existing `alineo_events` migration style)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS alineo_working_memory (
  resource_id   TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  value         JSONB       NOT NULL,
  updated_at    BIGINT      NOT NULL,
  PRIMARY KEY (resource_id, key)
);

CREATE TABLE IF NOT EXISTS alineo_memories (
  id            BIGSERIAL   PRIMARY KEY,
  resource_id   TEXT        NOT NULL,
  team_id       TEXT,
  content       TEXT        NOT NULL,
  embedding     VECTOR(1536),
  source_ref    TEXT,       -- e.g. sandboxId + ledger entry id this fact was derived from
  created_at    BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS alineo_memories_resource_id ON alineo_memories(resource_id);
CREATE INDEX IF NOT EXISTS alineo_memories_team_id ON alineo_memories(team_id);
CREATE INDEX IF NOT EXISTS alineo_memories_embedding_ivfflat
  ON alineo_memories USING ivfflat (embedding vector_cosine_ops);

ALTER TABLE alineo_memories ENABLE ROW LEVEL SECURITY;
-- Policy templated per deployment: restrict to current team_id from the connection's session context.
```

`source_ref` is the differentiator worth dwelling on: every semantic memory row can point back at
the exact `LedgerEntry` (sandbox ID + event) it was derived from. That means "why does the agent
believe this?" has an actual, replayable answer — re-run `readAll(name, sandboxId)` and see the
literal exec output the fact came from. No other framework surveyed ties memory provenance to a
durable execution log this directly, because none of them _have_ one to tie it to.

### 6.3 API sketch

```ts
import { Sandbox } from "@alineo-labs/sandbox";
import { Memory } from "@alineo-labs/memory";
import { PostgresAdapter } from "@alineo-labs/postgres";
import { nvidiaProvider } from "@alineo-labs/model-providers";

const adapter = new PostgresAdapter(process.env.DATABASE_URL!);
const memory = new Memory({ adapter, embeddingProvider: nvidiaProvider });

// Working memory — structured, per-resource facts
await memory.workingMemory.set("user-42", "preferred-language", "TypeScript");
const lang = await memory.workingMemory.get("user-42", "preferred-language");

// Semantic recall — team-scoped, provenance-linked
await memory.remember({
  resourceId: "user-42",
  teamId: "team-acme",
  content: "User prefers PRs under 300 lines.",
  sourceRef: { sandboxId: sb.sandboxId, entryId: 128 },
});

const relevant = await memory.recall({
  resourceId: "user-42",
  teamId: "team-acme", // omit to search only the user's own memories
  query: "how should I size this PR?",
  topK: 5,
});

// Wire straight into an agent
const client = new Sandbox({ baseUrl, adapter });
const agent = await Alineo.load(spec, { adapter, memory }); // agent.memory === memory, scoped to its own resourceId
```

### 6.4 The differentiator: memory time-travel via checkpoint/resume

This is the part nobody else in §3 can do, because it requires _both_ a durable memory store _and_ a
container-level snapshot mechanism, and only alineo has the second one already:

`sb.checkpoint("before-refactor")` already snapshots the container. Extend it (opt-in) to also
snapshot the _working-memory row set_ and the _set of semantic-memory IDs visible at that point_ into
the checkpoint payload. Then `client.resume(sandboxId)` doesn't just restore the filesystem and
replay execs — it restores **exactly what the agent believed at that moment**, not just what it had
done. That turns "resume this agent" into genuine time-travel debugging for agent _cognition_, not
just agent _execution_ — a materially different (and more useful) guarantee than LangGraph's
checkpoint replay (state only) or Letta's core-memory paging (no execution ledger to tie it to).

### 6.5 Cost/scalability profile of the proposal

| Concern                                         | This design                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| New infra to stand up                           | None — reuses `PostgresAdapter`/`SQLiteAdapter` already in the dependency tree                                                  |
| Incremental $/mo for a team already on Postgres | ~cost of one `pgvector` index (see §4: ~$45/mo _total_, not incremental, for 10M vectors on managed Postgres)                   |
| Multi-tenant isolation                          | Postgres RLS — a database guarantee, not app-layer filtering                                                                    |
| Local dev cost                                  | $0 — SQLite + sqlite-vec, same zero-infra story `@alineo-labs/sqlite` already tells for the ledger                              |
| Vendor lock-in                                  | None — embedding provider is pluggable via the existing `@alineo-labs/model-providers` registry                                 |
| Audit/compliance                                | Every memory write traceable to a ledger entry — a real answer to "why did the agent do that," not just "what did the agent do" |

---

## 7. Where this could get genuinely novel (beyond parity)

Parity with Mastra/Agno gets working memory + semantic recall. Two ideas go further, using
capabilities that are unique to alineo's execution model:

1. **Verified memory.** Because every fact can carry a `sourceRef` back into the ledger, a memory
   entry can be marked `verified: true` only if it's traceable to an actual exec result (e.g., "tests
   pass with X config" learned from a real `pytest` run) versus `unverified` if it came from a raw LLM
   claim. Nobody else in this survey can distinguish "the agent observed this" from "the agent
   asserted this," because nobody else has an execution ledger memory can point into.
2. **Forkable memory.** `sb.fork()` already exists for branching sandbox state cheaply (see
   [`cookbooks/parallel-test-shards`](../cookbooks/parallel-test-shards)). The same idea applies to
   memory: fork a resource's memory set copy-on-write when spawning parallel agent variants (e.g., A/B
   testing two prompt strategies against the same starting knowledge), then diff what each branch
   _learned_ — not just what each branch _produced_.

Both ideas are natural sequels to §6, not separate systems — they fall out of already tying memory
provenance to the ledger and already having cheap sandbox forking.

---

## 8. Phased roadmap

Deliberately front-loaded with the cheapest, highest-leverage piece first — working memory alone
covers the most common real-world usage pattern across every framework surveyed (a name, a
preference, a running total) and needs one table and no vector infra at all.

| Phase                              | Scope                                                                                                                                        | New infra required                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **0 — Working memory**             | `alineo_working_memory` table, `memory.workingMemory.get/set()`, wired into `Alineo` agent spec                                              | None                                                     |
| **1 — Episodic recall API**        | Read path over the existing ledger, reshaped by `resourceId`                                                                                 | None                                                     |
| **2 — Semantic recall**            | `alineo_memories` table, pgvector/sqlite-vec, `memory.remember()`/`memory.recall()`, pluggable embeddings via `@alineo-labs/model-providers` | `pgvector` extension (Postgres) or `sqlite-vec` (SQLite) |
| **3 — Team memory + RLS**          | `team_id` scoping, Postgres row-level security policies, `@alineo-labs/postgres` migration bump                                              | None beyond Postgres itself                              |
| **4 — Memory time-travel**         | Bind working/semantic memory snapshots into `sb.checkpoint()`/`client.resume()` payloads                                                     | None                                                     |
| **5 — Verified & forkable memory** | `sourceRef`-verified facts, copy-on-write memory forking alongside `sb.fork()`                                                               | None                                                     |

Phases 0–1 are shippable independent of any vector infrastructure decision, which matters: they
deliver the memory feature teams actually reach for most often, on day one, with zero new
dependencies — the same "zero infra to start, scale to Postgres when you need to" story
`@alineo-labs/sqlite`/`@alineo-labs/postgres` already tell for the ledger.

---

## 9. Open questions / risks

- **Embedding cost at scale** is real even without a vector-DB bill — every `remember()` call costs
  an embedding API call. Should be batchable and cacheable (dedupe near-identical facts before
  embedding), and the provider should be swappable to a local/free model for teams that want zero
  external API cost at the expense of recall quality.
- **Self-editing memory** (Agno/Letta's pattern of letting the agent write its own memory
  unsupervised) is powerful but risky without review. Verified/unverified marking (§7.1) is a partial
  answer; whether to _ever_ auto-delete a memory the agent decides is stale needs a policy, not just
  an API.
- **RLS is a Postgres-only guarantee.** The SQLite path (local dev, small teams) would need
  application-layer scoping instead — should be documented clearly as a weaker isolation guarantee,
  not silently assumed equivalent.
- **Ledger volume growth** — LangGraph's teams hit this with checkpoints; alineo's ledger would face
  the same pressure once episodic recall makes people query it more heavily. Worth planning retention
  policy from Phase 1, not backfilling it later.

---

## Sources

- [Mastra memory overview](https://mastra.ai/docs/memory/overview)
- [Mastra semantic recall](https://mastra.ai/docs/memory/semantic-recall)
- [Mastra observational memory](https://mastra.ai/docs/memory/observational-memory)
- [Using Mastra's Agent Memory API — Mastra Blog](https://mastra.ai/blog/agent-memory-guide)
- [LangGraph persistence docs](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Launching Long-Term Memory Support in LangGraph](https://www.langchain.com/blog/launching-long-term-memory-support-in-langgraph)
- [Separate Long-term memory and Checkpointing — LangChain Forum](https://forum.langchain.com/t/separate-long-term-memory-and-checkpointing/1668)
- [Understanding Agno: A Fast, Scalable Multi-Agent Framework — DigitalOcean](https://www.digitalocean.com/community/conceptual-articles/agno-fast-scalable-multi-agent-framework)
- [Agno vs LangGraph — ZenML Blog](https://www.zenml.io/blog/agno-vs-langgraph)
- [Agno Persistent Memory — Hindsight](https://hindsight.vectorize.io/blog/2026/04/09/agno-persistent-memory)
- [Flue: Headless, Programmable AI Agent Framework — Better Stack Community](https://betterstack.com/community/guides/ai/flue-framework/)
- [Bringing more agent harnesses to Cloudflare, starting with Flue — Cloudflare Blog](https://blog.cloudflare.com/agents-platform-flue-sdk/)
- [Vercel Introduces Eve — InfoQ](https://www.infoq.com/news/2026/06/vercel-eve-agents/)
- [Vercel Releases Eve — MarkTechPost](https://www.marktechpost.com/2026/06/17/vercel-releases-eve/)
- [What Is Vercel eve? — andrew.ooo](https://andrew.ooo/answers/what-is-vercel-eve-open-source-agent-framework-june-2026/)
- [Mem0 vs Letta vs Zep vs Cognee — MCP.Directory](https://mcp.directory/blog/mem0-vs-letta-vs-zep-vs-cognee-2026)
- [How Much Does a Vector Database Cost? — Mixpeek](https://mixpeek.com/guides/vector-database-cost-comparison)
- [Vector Database Pricing 2026: Pinecone vs pgvector vs Weaviate — Spendark](https://spendark.com/blog/vector-database-pricing/)
- [Vector DB Bills Exposed — LeanOps](https://leanopstech.com/blog/vector-database-cost-comparison-2026/)

Plus first-party alineo code: [`packages/core/src/ledger.ts`](../packages/core/src/ledger.ts),
[`packages/adapters/postgres/src/migrations.ts`](../packages/adapters/postgres/src/migrations.ts),
[`packages/model-providers/src/registry.ts`](../packages/model-providers/src/registry.ts),
[`.agents/skills/alineo/rules/agent-sdk.md`](../.agents/skills/alineo/rules/agent-sdk.md), and
[`CLAUDE.md`](../CLAUDE.md).
