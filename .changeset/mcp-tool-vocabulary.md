---
"alineo-mcp": minor
"@alineo-labs/schema": minor
---

**BREAKING:** every MCP tool is renamed to `{subject}_{verb}`, dropping the `alineod_` /
`alineo_` prefixes that named *which binary* rather than *what the tool acts on*.

| Before | Now |
|---|---|
| `alineod_create_run` · `alineod_get_run` · `alineod_delete_run` · `alineod_watch_events` | `run_start` · `run_get` · `run_stop` · `run_watch` |
| `alineod_spawn_agent` · `_get_agent` · `_prompt_agent` · `_steer_agent` · `_pause_agent` · `_resume_agent` · `_stop_agent` | `agent_spawn` · `agent_get` · `agent_prompt` · `agent_steer` · `agent_pause` · `agent_resume` · `agent_stop` |
| `alineod_get_result` | `result_get` |
| `alineo_add_spec` · `_list_specs` · `_remove_spec` · `alineo_init` | `spec_add` · `spec_list` · `spec_remove` · `init` |

An LLM picking a tool should be able to guess the name. `alineod_create_run` required knowing
that a daemon called alineod exists.

`run_stop`, not `run_delete`: the route aborts and closes every live agent but **keeps the
ledger**. HTTP keeps `DELETE /runs/:runId` — the method carries the verb there; a tool name has
to say it out loud.

`@alineo-labs/schema` gains three subjects — `event`, `result`, `transcript` — and one verb,
`deliver`. All four were already on the wire (`GET /agents/:id/transcript`,
`GET /runs/:id/events`, `POST /agents/:id/inbox/deliver`); they were vocabulary in use, just not
written down.

`scripts/check-vocabulary.ts` now also checks MCP tool names and alineod's HTTP routes, so all
four surfaces fail CI on an invented name.
