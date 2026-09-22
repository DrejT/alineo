# @alineo-labs/schema

The shared vocabulary every alineo surface derives its names from.

```bash
bun add @alineo-labs/schema
```

```ts
import { SUBJECTS, VERBS, isSubject, isVerb, parseName } from "@alineo-labs/schema";

parseName("agent_spawn", "_"); // → { subject: "agent", verb: "spawn" }
parseName("alineod_create_run", "_"); // → null
```

## Why this exists

One person meets the CLI, the SDK, the daemon's HTTP API, the MCP tools and the event stream.
Each of those was free to pick its own spelling, and each did — which is how `spawn` came to mean
"create a root agent" in the CLI and "create a child" in the SDK, and how `fork` came to mean
three different operations.

A glossary nobody can fail is a suggestion. These two lists are **data**, so CI can fail a name
instead of a reviewer having to catch it.

## The shape of a name

| Surface    | Pattern                       | Example                              |
| ---------- | ----------------------------- | ------------------------------------ |
| CLI        | `alineo <verb> [args]`        | `alineo spawn <parent> <child-spec>` |
| SDK method | the verb                      | `Alineo.spawn()`, `sb.checkpoint()`  |
| SDK class  | the subject                   | `Sandbox`, `Alineo`                  |
| HTTP       | `/{subjects}/:id/{verb}`      | `POST /agents/:agentId/steer`        |
| MCP tool   | `{subject}_{verb}`            | `agent_spawn`, `run_start`           |
| Event      | `{subject}.{past-tense verb}` | `agent.spawned`                      |

Subjects are singular here; only HTTP pluralizes its collection segment.

## What this package is not

It holds **no** event definitions, no Zod schemas and no wire types — only the words those are
built out of. The checks that enforce the lists live with the surfaces they police, so that a
surface cannot ship a name without also shipping the thing that would reject it.

## Two names that needed a decision

Both were flagged when this package was written and settled when the MCP check landed:

- **the tool that reads a settled agent's output** is `result_get`, not `agent_result`.
  `result` is a noun, so it belongs in `SUBJECTS` — and `agent_get` was already taken by the
  agent's own view. A run's records (`event`, `result`, `transcript`) were on the wire long
  before they were written down here.
- **`init`** has no subject at all. It is named for the verb alone, exactly as `alineo init`
  is on the CLI — so a bare verb is a legal tool name, not an exception to the pattern.
