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

## Known gaps, for whoever writes the MCP check

Two shipped names will not satisfy `parseName(name, "_")` and need a decision rather than a
silent allowlist:

- **`agent_result`** — `result` is a noun, not a verb. Either it joins `VERBS` or the tool
  becomes `agent_get` on a result-shaped route.
- **`init`** — no subject at all. It acts on the project directory, which is not a subject in
  this vocabulary and arguably should not be.
