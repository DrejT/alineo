# persistent-agent-memory

A support agent that remembers things about a customer across sessions — not within one
conversation (Pi already keeps that), but across separate sandbox sessions entirely, backed by
a real, persisted `@alineo-labs/memory` store.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
export NVIDIA_API_KEY=...   # https://build.nvidia.com — free tier available
```

## Run

```bash
bun install
bun start
```

## What it does

1. **Session 1** — loads `agents/support-agent.json` via `Alineo.load()`, wired with a `Memory`
   instance backed by `@alineo-labs/sqlite-memory` (a real file: `./.alineo/agent-memory.db`).
   Sets a working-memory profile (`plan`, `name`), runs a command, and `remember()`s a fact
   tagged with a `sourceRef` pointing at the real ledger entry that command produced — so it
   comes back `verified: true`, not just claimed. Prompts the agent, then closes the sandbox.
2. **Session 2** — calls `Alineo.load()` again with the **same spec** and the **same `Memory`
   instance**. This creates a brand-new sandbox (a different `sandboxId` — you'll see it in the
   output) with none of session 1's container state. Everything recalled — the working-memory
   profile, the verified fact — comes back purely because `agent.resourceRef` (which defaults
   to the agent's own `name`) is the same resource as session 1's, not because anything about
   the sandbox itself was preserved.
3. Uses `buildContextSnippet()` to assemble what's known about the customer into a plain-text
   block, prepended to the second session's prompt — so the agent's reply is grounded in real
   memory, not asked to guess.

## The point

Sandboxes are already durable — `sb.checkpoint()`/`resume()` preserve container state within
one logical session. What this recipe shows is a different kind of durability: memory that
survives past the sandbox session it was learned in entirely, addressed by a stable identity
(`resourceRef`) instead of a `sandboxId`.

## Where to go next

- [`examples/memory-basics`](https://github.com/DrejT/alineo/tree/main/examples/memory-basics)
  — every `@alineo-labs/memory` capability demonstrated standalone, no OpenSandbox needed:
  compaction, `SchemaWorkingMemory`, `episodicTree()`, `Memory.fork()` (which `Alineo.spawn()`
  calls automatically — not exercised in this recipe, since it needs a second agent spec and a
  `spawnDepth` budget beyond what this recipe's scope covers), and team access control.
- [`@alineo-labs/memory`'s own README](https://github.com/DrejT/alineo/tree/main/packages/memory)
  for the full API.

## Notes

The embedding call in `index.ts` (`nvidiaEmbeddings()`) is inlined rather than imported from
`@alineo-labs/model-providers`, since that package is private to this repo's own dashboard app —
not meant to be depended on from a cookbook someone copies out of this repo. Swap it for any
`EmbeddingProvider` (a different provider's API, a local model) with no other changes needed.
