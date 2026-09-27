---
"alineo-mcp": minor
---

**BREAKING:** alineod's event names are namespaced. `agent_spawned` → `agent.spawned`,
`run_started` → `run.started`, `handle_settled` → `handle.settled`, and so on for all sixteen —
on the ledger row, the bus message and the **SSE `event:` field**.

Forwarded harness events are renamed on the same stream: `tool_start` → `tool.started`,
`agent_start` → `session.started` (it was the harness's *session* beginning, never an agent's
lifecycle), and `text` → `message.updated` (it was always a delta of exactly one message).

**No aliases.** A permanent two-names-per-event table costs more than the break, so there is a
one-time idempotent migration instead — it runs at every alineod boot and does nothing on a
database that has already been through it.

Anything reading the SSE stream by event name needs updating. In this repo that is `alineo-mcp`
and the alineod docs, both changed here; the `run_watch` tool now returns the new names.

alineod also emits a `LedgerEnvelope` to sinks beside every row it already wrote. Sinks are
`@internal` for now — under the durable-execution decision the ledger is the system of record
and a sink is an export path, so the public shape of that belongs with the work that owns
export.
