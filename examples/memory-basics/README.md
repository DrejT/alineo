# memory-basics

A tour of every capability `@alineo-labs/memory` ships — working memory, semantic recall,
compaction, structured profiles, episodic memory, forkable memory, team access control, and
agent-callable tools — one section at a time.

## Setup

None. This example needs no OpenSandbox server, no API key, no network access at all.

## Run

```bash
bun install
bun start
```

## What it does

1. **Working memory** — set/get/list structured key-value facts.
2. **Semantic memory** — `remember()`/`recall()` by meaning, and the `verified` flag (computed
   from `sourceRef`, never caller-set).
3. **Compaction** — prune old/excess facts by count, or consolidate them via a `summarize`
   callback (a stand-in for a real LLM call here).
4. **`SchemaWorkingMemory`** — a validated, typed profile instead of raw key/value.
5. **Episodic memory** — `episodicRecall()` reading a hand-populated ledger (standing in for
   what real sandbox sessions write automatically when created with `resourceId`).
6. **`episodicTree()`** — the actual fork tree (a root session with two sibling forks), not a
   flattened stream.
7. **`Memory.fork()`** — an independent, mutable copy of a resource's memory.
8. **`withTeamAccessControl()`** — app-layer `teamId` enforcement, working even though this
   example uses the plain in-memory provider (which has no RLS of its own).
9. **`createMemoryTools()`** — tool definitions in the shape a model could call itself, executed
   directly here to show they work against the real `Memory` instance.

## The embedding provider is a toy, on purpose

Semantic ranking here uses a tiny deterministic "hashing-trick bag-of-words" vector (`
localBagOfWordsEmbeddings()` in `index.ts`) — enough to prove `remember()`/`recall()` actually
rank by content, with zero API key required. For real semantic quality, swap it for any
`EmbeddingProvider`: `createNvidiaEmbeddingProvider()` from `@alineo-labs/model-providers`, or
a small wrapper around OpenAI/Cohere/a local model — anything shaped `{id, embed(texts)}`.

## Where to go next

- [`@alineo-labs/memory`'s own README](https://github.com/DrejT/alineo/tree/main/packages/memory)
  for the full API and design rationale.
- [`@alineo-labs/sqlite-memory`](https://github.com/DrejT/alineo/tree/main/packages/adapters/sqlite-memory)
  / [`@alineo-labs/postgres-memory`](https://github.com/DrejT/alineo/tree/main/packages/adapters/postgres-memory)
  for real, persisted backends instead of the in-memory ones used here.
- [`cookbooks/persistent-agent-memory`](https://github.com/DrejT/alineo/tree/main/cookbooks/persistent-agent-memory)
  for the full picture: memory wired into a real Pi agent, persisted across sessions.
