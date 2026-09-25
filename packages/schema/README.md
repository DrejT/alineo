# @alineo-labs/schema

The shapes of the system: the ledger envelope, every event definition, and the vocabulary all
of alineo's surfaces derive their names from.

**Types and Zod schemas only — no behaviour, no IO.** What _does_ something with these shapes
lives in [`@alineo-labs/ledger`](../ledger). The split is why `@alineo-labs/memory` can stop
depending on the whole sandbox runtime just to borrow two types.

Two entry points:

| Import                      | Contains                                               | For                                                    |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `@alineo-labs/schema/types` | types only, no Zod in the graph                        | a package with no validator dependency that wants none |
| `@alineo-labs/schema`       | the above, plus the Zod schemas and the event registry | anything validating at a boundary                      |

## The vocabulary

```bash
bun add @alineo-labs/schema
```

```ts
import { SUBJECTS, VERBS, isSubject, isVerb, parseName } from "@alineo-labs/schema";

parseName("agent_spawn", "_"); // → { subject: "agent", verb: "spawn" }
parseName("alineod_create_run", "_"); // → null
```

### Why this exists

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

## The envelope

One record shape an event takes, whichever layer emitted it:

```ts
interface LedgerEnvelope<T, D> {
  v: 1;
  ts: number;
  type: T; // "agent.spawned", "exec.completed"
  runId?: string;
  agentId?: string;
  turnId?: string; // reserved; nothing generates turn ids yet
  causedBy?: EventRef; // the decision this fact followed from
  durable?: DurableRef; // { aggregate, seq, version } — present once persisted
  data: D;
}
```

Mostly a formalisation rather than an invention: alineod's ledger row is already five of these
eight fields. Before it, the same idea was written three ways — the SDK's `LedgerEntry`
(ordered by timestamp), alineod's row (ordered by `seq`), and the harness's bare
`{ type, ...fields }` stream — and a consumer reading one run end to end had to know all three.

**`seq` sits under `durable`, not at the top level.** A monotone sequence needs a single
writer for whatever it counts within, and there are two writers here in different processes.
So the writer assigns it at persist time, scoped to an aggregate: the run for alineod, the
sandbox session for the SDK.

## Events

```ts
import { defineEvent } from "@alineo-labs/schema";

export const AgentSpawned = defineEvent({
  type: "agent.spawned",
  durable: true,
  version: 1,
  schema: z.object({ agentId: z.string().nullable() /* … */ }),
});
```

One definition, three readers: the writer checks `durable` to decide whether to persist, a
reader uses `schema` to validate, and CI uses `type`. `defineEvent` refuses a name that is not
`<subject>.<past_tense_verb>`, a subject outside `SUBJECTS`, or a type defined twice.

Events are namespaced **by subject, not by the layer that emits them** — `agent.spawned`, not
`alineod.agent_spawned`. Someone reading one mixed stream needs to know what an event is
_about_, not which process produced it.

That settles three collisions for free: `run_started` meant both a workflow run and a swarm run
(now `workflow.started` and `run.started`); `agent_start` meant both a harness session beginning
and an alineod agent's lifecycle (now `session.started` and `agent.spawned`); and three
checkpoint-ish events collapse to two, with `snapshot` folding into
`sandbox.checkpoint_created` because that is what it always recorded.

`renames.ts` maps the old flat names to the new ones. It is **dated and deletable** — it exists
for a one-time store migration, not as a permanent alias table, and goes once no deployed
database predates the rename.
