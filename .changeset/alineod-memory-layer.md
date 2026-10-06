---
"@alineo-labs/schema": minor
---

Add `resourceRefOf(spec)` — the one rule for an agent's memory scope, `resourceId ?? name` plus
`teamId`, shared by the SDK and alineod — and the `memory` and `fact` subjects to the shared vocabulary, and the wire shapes for alineod's new
agent-memory routes (`MemoryView`, `MemoryValueBody`, `AddFactBody`, `FactsResponse`,
`CompactionBody`, …) in `@alineo-labs/schema/alineod`.

alineod now builds one durable `@alineo-labs/memory` store and hands it to every agent it starts,
resumes or reattaches, so `Alineo.spawn()` forks a parent's memory into each child — as it already
did for an SDK caller who set `opts.memory`, but which alineod never did. The routes
`GET|PUT|DELETE /agents/:id/memory[/:key]`, `GET|POST /agents/:id/facts` and
`POST /agents/:id/compactions` expose it; the vocabulary check needed the two new subjects to
accept those paths.
