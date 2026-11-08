---
"alineo-mcp": minor
"@alineo-labs/schema": minor
---

`alineo-mcp` exposes the alineod routes it was missing: 13 new tools, 29 in all.

- Waits: `agent_await` (subtree quiescence) and `run_await` (`settled` / `all` / `any` / `quorum`), so a client blocks server-side instead of polling `run_get`.
- Records: `transcript_get`.
- Messaging: `notify_add`, `inbox_list`, `inbox_deliver`.
- Memory: `memory_list`, `memory_get`, `memory_set`, `memory_remove`, `fact_add`, `fact_list`, `compaction_start`.
- `agent_steer`, `agent_pause`, `agent_resume` and `agent_stop` take an optional `scope: "subtree"` and then return alineod's per-member result.

`@alineo-labs/schema` adds `set` to `VERBS` for `memory_set` (`PUT /agents/:id/memory/:key`).
