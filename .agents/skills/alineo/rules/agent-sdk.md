# Agent SDK (`alineo`)

The bare `alineo` package is the **agent SDK** — it runs [Pi](https://pi.ai) coding agents inside
`@alineo-labs/sandbox` containers. Not to be confused with the `Sandbox` client
([API Reference](api-reference.md)): `Alineo` wraps a `Sandbox`/`SandboxHandle` and layers a Pi
bridge, snapshot-cached CLI install, streaming prompt/bash, and child-agent spawning on top.

```ts
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const agent = await Alineo.load("./agents/my-agent.json", { adapter });
try {
  for await (const chunk of textOnly(agent.prompt("Write and run a Python hello world script."))) {
    process.stdout.write(chunk);
  }
} finally {
  await agent.close();
}
```

`opts.adapter` is required — same `IStorageAdapter` you'd pass to `Sandbox` (`SQLiteAdapter` or
`PostgresAdapter`).

## Agent spec (`AgentSpec` JSON)

| Field        | Type                     | Notes                                                            |
| ------------ | ------------------------ | ----------------------------------------------------------------- |
| `name`       | `string`                 | Sandbox session name                                              |
| `cli`        | `"pi"`                   | Only `"pi"` currently                                             |
| `cliVersion` | `string?`                | Pin, e.g. `"0.80.2"`. Defaults to latest.                         |
| `model`      | `string?`                | Model ID, passed via `--model`                                    |
| `provider`   | `string?`                | AI provider via `--provider`; omit for direct API key             |
| `packages`   | `string[]?`              | APT packages installed before Pi                                  |
| `env`        | `Record<string,string>?` | `"${MY_KEY}"` resolves from host env                              |
| `resources`  | `object?`                | `{ cpu, memory }`                                                 |
| `setup`      | `SetupStep[]?`           | `{ name, run, cwd? }[]` — bash steps run before the snapshot      |
| `spawnDepth` | `number?`                | Nesting budget for `agent.spawn()`                                |
| `maxAgents`  | `number?`                | Optional cap on total descendants for this lineage                |

Changing `cli`/`cliVersion`/`packages`/`setup` invalidates the cached snapshot automatically.

Specs are validated by `validateAgentSpec()` (Zod-backed) before `load()`/`resume()` do anything
else — every field, every problem reported at once. An invalid spec throws
`AgentSpecValidationError`, not a bare `Error`: `.message` is a pre-formatted multi-line summary,
`.issues` is a structured `{ path, message, code }[]` for programmatic handling.

## Loading and lifecycle

| Call | Behavior |
|---|---|
| `Alineo.load(specPath, opts)` | Spin up (or restore from snapshot) a sandbox, install Pi, run setup, return a ready `Alineo`. `opts.rebuild: true` forces a full reinstall. |
| `Alineo.resume(sandboxId, opts)` | Reconnect after the host process exited. Restarts the bridge only — Pi/workspace untouched. |
| `Alineo.attach(sandboxId, opts)` | Connect **without** touching the bridge (unlike `resume`, which kills+restarts it). Use for `.spawn()`-only access — `.prompt()`/`.bash()` throw since there's no bridge. This is how `alineo fork` attaches from inside the very Pi bash-tool call spawning it. |
| `agent.close()` | Stop the container, release resources. Always call in `finally`. |

```
Load 1 (cold):   sandbox → Pi install → setup steps → checkpoint → bridge   ~50s
Load 2 (warm):   snapshot restore → bridge                                   ~5s
```

## Spawning child agents

`agent.spawn(childSpecPath, opts?)` forks **this agent's own live sandbox** — filesystem,
installed packages, uncommitted state, everything currently on disk — into a new independent
sandbox with its own Pi bridge. No install/setup steps re-run. Different from:
- `Alineo.load()` — always starts fresh from a spec's own snapshot.
- `agent.fork()`/`agent.clone()` — Pi's own conversation branching, same container/bridge.

Refuses unless `spawnDepth` (spec field or `opts.spawnDepth`) is a positive integer; each spawn
decrements it into the child's env. `maxAgents` is a separate, optional descendant-count ceiling
— not coordinated across parallel sibling spawns.

## Streaming

`agent.prompt(message, opts?)` and `agent.bash(command)` return an `AgentStream`
(`AsyncIterable<AgentEvent>`). `AgentEvent` is a large discriminated union — `text`, `tool_start`,
`tool_update`, `tool_end`, `agent_start`/`agent_end`, `turn_start`/`turn_end`,
`compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, etc. Use
`textOnly(stream)` to filter to just `text` chunks; iterate the raw stream to observe tool calls.

## Mid-flight control & session management

| Call | Behavior |
|---|---|
| `agent.steer(message)` | Redirect Pi's current response mid-flight |
| `agent.followUp(message)` | Queue a message for after the current task finishes |
| `agent.abort()` | Interrupt the in-progress response |
| `agent.newSession()` | Fresh Pi conversation; filesystem unchanged |
| `agent.clone()` | Branch at current position → `{ cancelled }` |
| `agent.fork(entryId)` | Branch from a specific history entry → `{ text, cancelled }` |
| `agent.getMessages()` / `agent.getForkMessages()` | Full history / available fork entry points |
| `agent.setModel(provider, modelId)` / `agent.cycleModel()` | Model switching |
| `agent.setThinkingLevel(level)` / `agent.cycleThinkingLevel()` | Reasoning effort |
| `agent.compact(instructions?)` / `agent.setAutoCompaction(bool)` | Context compaction |
| `agent.setAutoRetry(bool)` / `agent.abortRetry()` | Retry on 429/500/502/503/504 (on by default: 3 attempts, 2s/4s/8s backoff) |
| `agent.setEnv(vars)` | Update container env; restarts Pi to pick it up |
| `agent.getSessionStats()` / `agent.getLogs()` / `agent.exportHtml()` | Inspection/export |

`agent.sandbox` gives direct access to the underlying `SandboxHandle` — `exec()`, `readFile()`,
`writeFile()`, etc. — independent of Pi.

## Properties

| Property | Type | Notes |
|---|---|---|
| `agent.sandboxId` | `string` | OpenSandbox container ID |
| `agent.name` | `string` | Name from the spec |
| `agent.sandbox` | `SandboxHandle` | Underlying sandbox object |
| `agent.fromSnapshot` | `boolean` | `true` when restored from cache |

Full reference: `packages/agent/README.md`.
