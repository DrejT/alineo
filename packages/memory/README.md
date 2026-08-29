# `@alineo-labs/memory`

A provider-agnostic memory layer for alineo agents: working memory, semantic recall, and
episodic recall over the existing ledger — scoped by a durable `resourceId` that survives past
any one sandbox session.

This package owns memory **concepts, scoping, and pipeline** (injection, compaction,
lifecycle hooks). It does not own a storage backend itself — bring your own
`IWorkingMemoryProvider` / `ISemanticMemoryProvider`, whether that's the in-memory reference
implementations shipped here, the file-based `@alineo-labs/sqlite-memory` backend, or the
shared `@alineo-labs/postgres-memory` backend.

## Why `resourceId`, not `sandboxId`

A `sandboxId` identifies one sandbox _session_. A `resourceId` is a durable identity (a user,
an account, a project) expected to outlive any number of sandbox sessions. Working and
semantic memory are keyed by `resourceId` because their entire point is surviving past the
session they were learned in.

`resourceId` (and `parentSandboxId`, for forked sandboxes) ride along in the ledger's existing
`sandbox_created` event payload — the same mechanism `SandboxDetails.runId` already used —
so there's no ledger schema change. Set it when creating a sandbox:

```ts
const sb = await client.sandbox({
  image: "node:22",
  resources: { cpu: "500m", memory: "512Mi" },
  resourceId: "user-42", // ties this session's memory to a durable resource
});
```

`resume()`, `restoreSnapshot()`, and `sb.fork()` all inherit the originating session's
`resourceId` automatically, the same way they already inherit `runId`.

```ts
import type { ResourceRef } from "@alineo-labs/memory";

const ref: ResourceRef = { resourceId: "user-42" }; // teamId?: string for shared/team scoping
```

## Three capabilities, three independent slots

Memory is split by capability, not unified into one adapter — real backends support genuinely
different capability subsets, so a monolithic interface would force fake implementations of
capabilities a backend doesn't have.

### Working memory — required

Structured per-resource key/value facts. Every `Memory` instance needs at least this.

```ts
import { Memory, InMemoryWorkingMemoryProvider } from "@alineo-labs/memory";

const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

await memory.workingMemory.set(ref, "preferredLanguage", "TypeScript");
await memory.workingMemory.get(ref, "preferredLanguage"); // "TypeScript"
await memory.workingMemory.list(ref); // { preferredLanguage: "TypeScript" }
await memory.workingMemory.delete(ref, "preferredLanguage");
```

### Semantic memory — optional

Vector recall over remembered facts. Omitting it is a first-class, typed state: calling
`remember()`/`recall()` on a `Memory` with no semantic provider throws `MemoryCapabilityError`.

```ts
import {
  Memory,
  InMemoryWorkingMemoryProvider,
  InMemorySemanticMemoryProvider,
} from "@alineo-labs/memory";

const memory = new Memory({
  workingMemory: new InMemoryWorkingMemoryProvider(),
  semantic: new InMemorySemanticMemoryProvider(myEmbeddingProvider),
});

await memory.remember(ref, { content: "prefers dark mode" });
const facts = await memory.recall(ref, "UI preferences", { topK: 5 });
```

`EmbeddingProvider` is a minimal `{ id, embed(texts) }` shape — pass any embedding model you
like. `@alineo-labs/model-providers` ships `createNvidiaEmbeddingProvider()`, matching this
shape structurally with no dependency on this package at all.

#### Verified memory

Every fact returned by `recall()`/`listAll()` carries a computed `verified` flag: `true` when
`remember()` was called with a `sourceRef` pointing at a real ledger entry, `false` for a
free-form fact. This is computed, never caller-set — passing `verified: true` on a free-form
fact's input is silently ignored:

```ts
await memory.remember(ref, {
  content: "user confirmed the refund",
  sourceRef: { sandboxId: sb.sandboxId, entryIndex: 42 }, // ties it to a real ledger entry
});

const [fact] = await memory.recall(ref, "refund");
fact.verified; // true — traceable back to that ledger entry
```

A fact worth trusting more than a hallucinated summary is one you can point at real execution
history — no other memory framework can do this because it requires an execution ledger to
point _at_ in the first place.

### Episodic memory — a function, not a provider

A read-shaped view over the sandbox ledger, reshaped by `resourceId`. No new storage.

```ts
import { episodicRecall } from "@alineo-labs/memory";

const entries = await episodicRecall(adapter, ref, { limit: 100 });

// Include ancestor sessions reached via sb.fork()'s parentSandboxId chain:
const withHistory = await episodicRecall(adapter, ref, { branch: "lineage" });
```

By default, sessions are resolved by matching `SandboxDetails.resourceId` (or, for ledger data
written before that field existed, by matching the ledger's `name` against `resourceId`).
Supply `resolveSessions` to use a different convention entirely.

#### Branch-true episodic memory

`episodicRecall({branch: "lineage"})` flattens fork ancestry into one merged stream — good
enough for "what led up to this session," but it can't tell you "what happened on a _sibling_
branch forked from the same point." `episodicTree()` returns the actual fork tree instead:

```ts
import { episodicTree } from "@alineo-labs/memory";

const [root] = await episodicTree(adapter, ref);
root.entries; // this session's own ledger entries
root.children; // sessions forked from it — each with its own .entries and .children
```

Every resolved session's ancestor chain is pulled in automatically (same as `lineage`), so a
tree with a resolved-but-orphaned node never happens — its ancestors are added as parents even
if they weren't in the original resolved set.

## Real backends

| Package                              | Working memory                  | Semantic memory                  | Notes                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@alineo-labs/memory` (this package) | `InMemoryWorkingMemoryProvider` | `InMemorySemanticMemoryProvider` | Process-local, non-durable — reference implementations only.                                                                                                                                                                                           |
| `@alineo-labs/sqlite-memory`         | `SQLiteWorkingMemoryProvider`   | `SQLiteSemanticMemoryProvider`   | File-based via `bun:sqlite`, zero external services, survives restarts. Ranks recall with `sqlite-vec`'s native `vec0` index when the extension loads (verified on win32/x64); falls back to an in-JS cosine scan otherwise — check `.hasVectorIndex`. |
| `@alineo-labs/postgres-memory`       | `PostgresWorkingMemoryProvider` | `PostgresSemanticMemoryProvider` | Shared, multi-process backend. Row-level security isolates `teamId`-scoped rows. Ranks recall with a `pgvector` HNSW index when the extension can be installed; falls back to an in-JS cosine scan otherwise — check `.hasVectorIndex`.                |

```ts
import { Memory } from "@alineo-labs/memory";
import {
  SQLiteWorkingMemoryProvider,
  SQLiteSemanticMemoryProvider,
} from "@alineo-labs/sqlite-memory";
import { createNvidiaEmbeddingProvider } from "@alineo-labs/model-providers";

const memory = new Memory({
  workingMemory: new SQLiteWorkingMemoryProvider("./alineo-memory.db"),
  semantic: new SQLiteSemanticMemoryProvider("./alineo-memory.db", createNvidiaEmbeddingProvider()),
});
```

Neither backend package has been run against a live database in this repo's own test suite
(no Postgres instance, and the SQLite one is unit-tested with `bun:sqlite` directly) — they
ship type-checked and, for SQLite, tested against a real file; treat the Postgres one as
reviewed-but-unverified until it's run against an actual server.

## Compaction

A `remember()`'d fact stays verbatim forever unless pruned. `compactSemanticMemory()` (or
`Memory.compactSemanticMemory()`) drops old/excess facts, for any provider implementing the
optional `IPrunableSemanticMemoryProvider` capability (`listAll`/`forget` — all three semantic
providers above support it):

```ts
await memory.compactSemanticMemory(ref, { maxFacts: 500, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
```

Age-based removal runs first; the count cap is then applied to whatever's left. Throws if the
configured provider doesn't support pruning.

Pass `summarize` to consolidate instead of just deleting — it receives the facts about to be
removed (oldest first) and returns replacement contents, written _before_ the originals are
dropped:

```ts
await memory.compactSemanticMemory(ref, {
  maxFacts: 500,
  summarize: async (facts) => [
    await myLlmCall(`Summarize into one fact: ${facts.map((f) => f.content).join("; ")}`),
  ],
});
```

`summarize` is caller-supplied — this package never depends on a concrete model, the same
principle as `EmbeddingProvider`.

### Automatic compaction

Configure `autoCompact` on `Memory` to run a compaction check after every `remember()`, instead
of remembering to call `compactSemanticMemory()` yourself on a schedule:

```ts
const memory = new Memory({
  workingMemory: new InMemoryWorkingMemoryProvider(),
  semantic: new InMemorySemanticMemoryProvider(embeddings),
  autoCompact: { maxFacts: 500, checkEvery: 10 }, // check once per 10 remember() calls
});
```

Silently skipped if the configured provider doesn't support pruning; a failed compaction
check fails the `remember()` call it rode along with (not silently swallowed) — raise
`checkEvery`, or call `compactSemanticMemory()` on a separate schedule instead, to decouple
the two.

## Context injection

`buildContextSnippet(memory, ref, opts)` assembles a plain-text block from a resource's working
memory and (if a query is given and a semantic provider is configured) its most relevant
semantic memories — ready to prepend to a prompt:

```ts
import { buildContextSnippet } from "@alineo-labs/memory";

const context = await buildContextSnippet(memory, ref, { query: userMessage, topK: 5 });
for await (const chunk of agent.prompt(context ? `${context}\n\n${userMessage}` : userMessage)) {
  process.stdout.write(chunk);
}
```

This builds the string only — `alineo`'s Pi bridge has no hook today for prepending to a
session's system prompt automatically, so injecting it into an actual conversation is still a
call the surrounding app makes.

## Structured working memory

`IWorkingMemoryProvider` is raw, untyped key/value. `SchemaWorkingMemory<T>` wraps it with a
validated, typed profile stored under one key — useful for the common "agent maintains a
structured user profile" shape:

```ts
import { z } from "zod";
import { SchemaWorkingMemory } from "@alineo-labs/memory";

const ProfileSchema = z.object({
  name: z.string().optional(),
  preferredLanguage: z.string().optional(),
});

const profile = new SchemaWorkingMemory(workingMemoryProvider, ProfileSchema);
await profile.update(ref, { preferredLanguage: "TypeScript" }); // merges + validates
await profile.get(ref); // { preferredLanguage: "TypeScript" }
```

`SchemaValidator<T>` is a minimal `{ parse(data): T }` shape — any Zod schema satisfies it
directly; this package never depends on a concrete schema library.

## Agent-callable memory tools

`createMemoryTools(memory, ref)` returns a set of tool definitions (name, description, JSON
Schema parameters, executor) in the shape most agent tool-calling conventions expect — so a
_model_, not just the surrounding application code, can decide to persist or retrieve a fact
mid-conversation:

```ts
import { createMemoryTools } from "@alineo-labs/memory";

const tools = createMemoryTools(memory, ref);
// [{ name: "set_working_memory", ... }, { name: "get_working_memory", ... },
//   { name: "remember_fact", ... }, { name: "recall_facts", ... } — last two only if
//   memory.hasSemanticMemory ]
```

`alineo`'s Pi bridge doesn't yet expose a way to register caller-defined tools into a running
Pi session, so wiring these into an actual live agent conversation is left to the caller today
— this ships the tool _definitions_, ready to adapt into whatever surface ends up supporting
them.

## Forkable memory

Sandboxes already fork copy-on-write via `sb.fork()`; `Memory.fork()` gives memory the same
property — an independent snapshot copy the child can mutate without ever touching the
parent's:

```ts
const {
  ref: childRef,
  workingKeysCopied,
  semanticFactsCopied,
} = await memory.fork(parentRef, "child-resource-id");

await memory.workingMemory.set(childRef, "note", "only visible to the child now");
await memory.workingMemory.get(parentRef, "note"); // undefined — the parent is untouched
```

Working memory is always copied in full. Semantic memory is copied only if the configured
provider supports the pruning capability (`listAll` is what makes enumerating "everything to
copy" possible) — `semanticFactsCopied` is `0`, not an error, otherwise.

`Alineo.spawn()` calls this automatically when the parent agent has `.memory` configured — a
spawned child (a sandbox-level fork under the hood) gets its own independent memory copy with
no extra wiring.

## Team access control

`ResourceRef.teamId` isolates data _structurally_ in every backend (it's part of the storage
key), but only `@alineo-labs/postgres-memory` enforces it as an actual access-control boundary
via row-level security — a caller for the in-memory or SQLite backends who deliberately passes
the "wrong" `teamId` can still read it. `withTeamAccessControl()` /
`withTeamAccessControlSemantic()` close that gap for any backend:

```ts
import { withTeamAccessControl, withTeamAccessControlSemantic } from "@alineo-labs/memory";

const checker = { canAccess: (teamId: string) => currentUser.teamIds.includes(teamId) };

const memory = new Memory({
  workingMemory: withTeamAccessControl(new SQLiteWorkingMemoryProvider("./mem.db"), checker),
  semantic: withTeamAccessControlSemantic(mySemanticProvider, checker),
});
```

Every call on a `ResourceRef` carrying a `teamId` is checked against `checker.canAccess()`
first, throwing `MemoryAccessDeniedError` before the wrapped provider is ever touched. A `ref`
with no `teamId` always passes through untouched. Works alongside Postgres's own RLS for
defense-in-depth — it isn't an either/or.

## Sandbox lifecycle binding

`createMemoryLifecycleHooks(memory, ref)` returns a `SandboxHooks` object (composable via
`@alineo-labs/core`'s `composeHooks()`) that records the most recently active `sandboxId` and
the most recent checkpoint's metadata into working memory — a durable answer to "what was the
last checkpoint for this resource" without re-deriving it from the ledger every time. It does
not restore sandbox state itself; that's `@alineo-labs/core`'s job.

```ts
import { composeHooks } from "@alineo-labs/core";
import { createMemoryLifecycleHooks } from "@alineo-labs/memory";

const sb = await client.sandbox({
  image: "node:22",
  resources: { cpu: "500m", memory: "512Mi" },
  resourceId: ref.resourceId,
  hooks: composeHooks([createMemoryLifecycleHooks(memory, ref)]),
});
```

## Agent wiring

`alineo`'s `Alineo` class accepts an optional `memory` on `load()`/`resume()`/`attach()`, and
`spawn()` carries it over to the child automatically:

```ts
const agent = await Alineo.load(spec, { adapter, memory });
await agent.memory?.remember(agent.resourceRef, { content: "user prefers concise answers" });
```

`agent.resourceRef` defaults `resourceId` to the agent's own `name` — the same convention
`episodicRecall()`'s default resolver expects, so no extra wiring is needed to make episodic
recall work for an agent's own sandbox sessions.

`Alineo.spawn()` also calls `memory.fork()` automatically (see "Forkable memory" above) when
the parent has `.memory` configured — a spawned child gets its own independent memory copy,
seeded from the parent, with no extra call needed.

## What's intentionally out of scope here

- **Pi tool-call integration** — `createMemoryTools()` produces framework-agnostic tool
  definitions; actually registering them into a running Pi session needs a change to
  `alineo`'s Pi bridge that hasn't been made.
- **Automatic prompt injection** — `buildContextSnippet()` builds the string; nothing calls it
  automatically at session start. That's still an explicit call the surrounding app makes.
- **A ledger-native branch/lane concept** — `episodicTree()` reconstructs the fork tree from
  `parentSandboxId` at read time; alineo's ledger itself still has no first-class branch
  concept the way e.g. Pi's own session storage does. If the ledger ever grows one,
  `episodicTree()` would become a thinner read over it instead of doing the reconstruction
  itself.
- **`withTeamAccessControl()` is app-layer, not a security boundary of its own** — it's a
  correct-by-construction gate in front of whatever backend, but the `TeamAccessChecker` you
  supply is doing all the real work; a buggy or bypassed checker is still a hole. It doesn't
  replace real infrastructure-level isolation for a genuinely adversarial multi-tenant setup.
- Restoring sandbox filesystem/process state from a checkpoint — `createMemoryLifecycleHooks`
  only records checkpoint _metadata_ into working memory; the actual restore is
  `@alineo-labs/core`'s `resume()`.

## Examples & cookbook

- [`examples/memory-basics`](https://github.com/DrejT/alineo/tree/main/examples/memory-basics)
  — every capability on this page, demonstrated standalone. No OpenSandbox, no API key.
- [`cookbooks/persistent-agent-memory`](https://github.com/DrejT/alineo/tree/main/cookbooks/persistent-agent-memory)
  — the real end-to-end scenario: a Pi agent whose memory survives across separate sandbox
  sessions entirely, using `@alineo-labs/sqlite-memory`.
