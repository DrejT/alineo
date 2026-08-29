---
"@alineo-labs/memory": minor
"@alineo-labs/sqlite-memory": minor
---

Close the highest-leverage gaps against feature-parity frameworks (real vector indexing,
LLM-based compaction, structured working memory, agent-callable tools, automatic pipeline
orchestration):

**Real native vector indexing (`@alineo-labs/sqlite-memory`)** — `SQLiteSemanticMemoryProvider`
now ranks `recall()` using `sqlite-vec`'s native `vec0` virtual table (verified working on
win32/x64) instead of a JS-level scan, scoped correctly via `vec0`'s partition-key mechanism
rather than a post-join filter (the naive approach silently drops or misorders results once
multiple resources share one table — caught and fixed via a regression test). Falls back to
the previous in-JS cosine scan if the extension fails to load on a given platform; check
`provider.hasVectorIndex`.

**LLM-based compaction (`@alineo-labs/memory`)** — `compactSemanticMemory()` accepts a
`summarize` callback: facts selected for removal are consolidated into fewer, denser
replacement facts (caller-supplied, no dependency on a concrete model) before the originals
are dropped, instead of only ever deleting.

**Automatic compaction** — `Memory`'s new `autoCompact` option runs a compaction check after
every `remember()` (or every Nth, via `checkEvery`), so the package can own compaction
scheduling instead of requiring the caller to remember to call it.

**Context injection pipeline** — `buildContextSnippet(memory, ref, opts)` assembles a
plain-text block from working memory and (optionally) semantic recall, ready to prepend to a
prompt.

**Structured working memory** — `SchemaWorkingMemory<T>` wraps `IWorkingMemoryProvider` with a
validated, typed profile merged and checked against a caller-supplied schema
(`{parse(data): T}` — any Zod schema satisfies this with no new dependency).

**Agent-callable memory tools** — `createMemoryTools(memory, ref)` returns tool definitions
(name/description/JSON-Schema parameters/executor) in the shape most agent tool-calling
conventions expect, so a model can decide to persist/retrieve memory mid-conversation. Actual
registration into a running Pi session is left to the caller — `alineo`'s Pi bridge has no
tool-registration hook yet.
