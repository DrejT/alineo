# Agent SDK (`alineo`)

The bare `alineo` package is the **agent SDK** — it runs [Pi](https://pi.ai) coding agents inside
`@alineo-labs/sandbox` containers (not covered by this skill). `Alineo` wraps a
`Sandbox`/`SandboxHandle` and layers a Pi bridge, snapshot-cached CLI install, streaming
prompt/bash, and child-agent spawning on top.

```ts
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const agent = await Alineo.start("./agents/my-agent.json", { adapter }); // a path or an AgentSpec object
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

Source of truth: `packages/schema/src/agent-spec.ts` (interface + Zod, kept in step by a drift test).
The old field names `cli`/`cliVersion` are gone — they are `harness`/`harnessVersion`.

| Field                                                      | Type                                                | Notes                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                     | `string`                                            | Sandbox session name                                                                                                                          |
| `harness`                                                  | `"pi"`                                              | Agent-loop driver. Only `"pi"` today                                                                                                          |
| `harnessVersion`                                           | `string?`                                           | npm specifier for the harness, e.g. `"0.80.2"`. Defaults to latest                                                                            |
| `model`                                                    | `string`                                            | **Required.** Passed via `--model`; a result must be attributable to a model                                                                  |
| `provider`                                                 | `string?`                                           | AI provider via `--provider`; omit for direct API key                                                                                         |
| `packages`                                                 | `string[]?`                                         | APT packages installed before the harness                                                                                                     |
| `env`                                                      | `Record<string, string \| CredentialEnvBinding>?`   | `"${MY_KEY}"` resolves from host env. A `CredentialEnvBinding` never becomes a container env var — see [Credentials](#credentials-and-egress) |
| `resources`                                                | `{ cpu, memory, gpu? }?`                            | Falls back to `alineo.config.json` `defaults.resources`                                                                                       |
| `setup`                                                    | `SetupStep[]?`                                      | `{ name, run, cwd? }[]` — bash steps run before the snapshot                                                                                  |
| `spawnDepth`                                               | `number?`                                           | Nesting budget for `agent.spawn()`; omit = spawning disabled                                                                                  |
| `maxAgents`                                                | `number?`                                           | Optional cap on total descendants for this lineage                                                                                            |
| `permissions`                                              | `"auto" \| "ask" \| "readonly" \| PermissionPolicy` | Human-in-the-loop tool-call gate, default `"auto"` — see [Permissions](#permissions)                                                          |
| `onFailure`                                                | `"fail" \| "ask" \| "retry"`                        | Failed-turn policy, default `"fail"` — see [Failure policy](#failure-policy)                                                                  |
| `maxRetries`                                               | `number?`                                           | Required in effect when `onFailure: "retry"`; no default                                                                                      |
| `maxConsecutiveFailures`                                   | `number?`                                           | Circuit breaker, default 3                                                                                                                    |
| `checkpoint`                                               | `boolean?`                                          | Opt in to a turn checkpoint after every clean turn — see [Turn checkpoints](#turn-checkpoints)                                                |
| `teamId` / `resourceId`                                    | `string?`                                           | Memory scope identity for `agent.resourceRef` (`resourceId` defaults to `name`)                                                               |
| `metadata`, `title`, `description`, `author`, `categories` | —                                                   | Registry-facing; `metadata` has no runtime effect                                                                                             |
| `registryDependencies`                                     | `string[]?`                                         | Used by `alineo add` only                                                                                                                     |

Changing `harness`/`harnessVersion`/`packages`/`setup` invalidates the cached setup snapshot
automatically. `permissions`, `onFailure` and `checkpoint` do not.

Specs are validated by `validateAgentSpec()` (Zod-backed) before `start()`/`resume()` do anything
else — every field, every problem reported at once. An invalid spec throws
`AgentSpecValidationError`, not a bare `Error`: `.message` is a pre-formatted multi-line summary,
`.issues` is a structured `{ path, message, code }[]` for programmatic handling.

## Loading and lifecycle

| Call                               | Behavior                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Alineo.start(specPath, opts)`     | Spin up (or restore from snapshot) a sandbox, install Pi, run setup, return a ready `Alineo`. `opts.rebuild: true` forces a full reinstall.                                                                                                                       |
| `Alineo.reattach(sandboxId, opts)` | Reconnect to a live sandbox, **keeping its bridge** if it is alive. Try this first; fall back to `resume` if it throws. `skipReadyCheck: true` accepts a Paused sandbox (resume it yourself, then `agent.adapter.waitReady()`).                                   |
| `Alineo.resume(sandboxId, opts)`   | The bridge really is gone: restarts it. Pi/workspace untouched. If the container itself is gone, restores from the latest turn checkpoint into a fresh container (needs `checkpoint: true` on the spec).                                                          |
| `Alineo.attach(sandboxId, opts)`   | Connect **without** touching the bridge (unlike `resume`, which kills+restarts it). Use for `.spawn()`-only access — `.prompt()`/`.bash()` throw since there's no bridge. This is how `alineo spawn` attaches from inside the very Pi bash-tool call spawning it. |
| `agent.close()`                    | Stop the container, release resources. Always call in `finally`.                                                                                                                                                                                                  |

Every constructor takes `opts.adapter` (required) and optionally `opts.memory` (a `Memory` instance, exposed as `agent.memory`) and `opts.config`/`opts.runId`.

```
Load 1 (cold):   sandbox → Pi install → setup steps → checkpoint → bridge   ~50s
Load 2 (warm):   snapshot restore → bridge                                   ~5s
```

## Spawning child agents

`agent.spawn(childSpecPath, opts?)` forks **this agent's own live sandbox** — filesystem,
installed packages, uncommitted state, everything currently on disk — into a new independent
sandbox with its own Pi bridge. No install/setup steps re-run. Different from:

- `Alineo.start()` — always starts fresh from a spec's own snapshot.
- `agent.branchSession()`/`agent.duplicateSession()` — harness conversation branching, same container/bridge.

Refuses unless `spawnDepth` (spec field or `opts.spawnDepth`) is a positive integer; each spawn
decrements it into the child's env. `maxAgents` is a separate, optional descendant-count ceiling
— not coordinated across parallel sibling spawns.

## Permissions

`permissions` gates every tool call before it runs, via a bundled Pi extension. `"auto"` (default)
never asks; `"ask"` asks before every call; `"readonly"` auto-allows reads and asks before writes/exec;
a `PermissionPolicy` is ordered per-tool/per-pattern rules, last match wins.

For anything but `"auto"`, a `permission_request` event appears on the agent stream (recorded in the
ledger as `permission.requested`). Resolve it with a `PermissionDecision` — `{ kind: "once" }`,
`{ kind: "always" }` or `{ kind: "reject", feedback? }`:

```ts
for await (const ev of agent.prompt("...")) {
  if (ev.type === "permission_request") {
    await agent.resolvePermission(ev.requestId, { kind: "once" });
  }
}
await agent.listPendingPermissions(); // anything still waiting
```

`prompt()` also takes an `onPermission` handler in its options. `reject`'s `feedback` becomes the
reason the model reads.

A request that is dropped (bridge died mid-ask) is recorded honestly as dropped, not as allowed.

## Credentials and egress

An `env` value can be a `CredentialEnvBinding` (`{ credential, host, pathPrefix?, injection, approval? }`)
instead of a string: the secret never becomes a container env var; it is injected into matching
**outbound requests** at the egress proxy. `injection` is a header form or
`{ type: "substitution", placeholder, in: ["path"|"query"|"header"|"body"] }`. `approval: "hold"`
makes a matching request wait for a human — `agent.pendingEgressRequests()` lists them.
`networkPolicy`/`credentialProxy` sandboxes need a server that can probe the egress sidecar
(`alineo init` sets `host_ip` for that) and are rejected under the gVisor runtime.

## Failure policy

A turn can end without finishing: an upstream model-API error, a tool failure, alineod restarting.
`onFailure` chooses what happens:

| Value              | On a failed turn                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `"fail"` (default) | The turn settles failed, with the error                                                                |
| `"ask"`            | The agent is held `blocked` until someone prompts (retry, optionally with corrective text) or stops it |
| `"retry"`          | Re-prompts up to `maxRetries`, then holds as `"ask"`                                                   |

`maxConsecutiveFailures` (default 3) blocks the agent regardless of policy so a retry budget or a
patient operator can't become a cost loop. Supervision is opt-in: a turn may have real side
effects (a `git push`), so a retry can repeat them. Policy is enforced by alineod; the SDK
itself surfaces a failed turn, it does not auto-retry across turns.

## Turn checkpoints

`checkpoint: true` captures a tarball of the agent's home directory (`/root`: Pi's session file and
what the agent wrote there) after every turn that ends `done`, so `Alineo.resume()` can restore the
conversation if the container is later gone entirely. Only `/root` is captured — `/tmp`,
`/workspace` and anywhere else come back as the setup snapshot left them. Off by default (extra I/O
every turn). Retention keeps the newest three per sandbox. A turn that was running when the
container died is recorded as `agent.turn_interrupted`, never silently dropped or repeated.

## Streaming

`agent.prompt(message, opts?)` and `agent.bash(command)` return an `AgentStream`
(`AsyncIterable<AgentEvent>`). `AgentEvent` is a large discriminated union — `text`, `tool_start`,
`tool_update`, `tool_end`, `permission_request`, `agent_start`/`agent_end`, `turn_start`/`turn_end`,
`compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, etc. Use
`textOnly(stream)` to filter to just `text` chunks; iterate the raw stream to observe tool calls.

## Mid-flight control & session management

| Call                                                                 | Behavior                                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.steer(message)`                                               | Redirect Pi's current response mid-flight                                                                                                                                       |
| `agent.followUp(message)`                                            | Queue a message for after the current task finishes                                                                                                                             |
| `agent.abort()`                                                      | Interrupt the in-progress response                                                                                                                                              |
| `agent.newSession()`                                                 | Fresh Pi conversation; filesystem unchanged                                                                                                                                     |
| `agent.duplicateSession()`                                           | Branch the conversation here → `{ cancelled }`                                                                                                                                  |
| `agent.branchSession(entryId)`                                       | Branch the conversation from a history entry → `{ text, cancelled }`                                                                                                            |
| `agent.getMessages()` / `agent.getBranchPoints()`                    | Full history / where the conversation can branch                                                                                                                                |
| `agent.setModel(provider, modelId)` / `agent.cycleModel()`           | Model switching                                                                                                                                                                 |
| `agent.getAvailableModels()`                                         | List every model available to Pi under the current provider config — the way to find a valid `modelId` for `setModel()`/a spec's `model` field, rather than guessing the string |
| `agent.setThinkingLevel(level)` / `agent.cycleThinkingLevel()`       | Reasoning effort                                                                                                                                                                |
| `agent.compact(instructions?)` / `agent.setAutoCompaction(bool)`     | Context compaction                                                                                                                                                              |
| `agent.setAutoRetry(bool)` / `agent.abortRetry()`                    | Retry on 429/500/502/503/504 (on by default: 3 attempts, 2s/4s/8s backoff)                                                                                                      |
| `agent.setEnv(vars)`                                                 | Update container env; restarts Pi to pick it up                                                                                                                                 |
| `agent.getSessionStats()` / `agent.getLogs()` / `agent.exportHtml()` | Inspection/export                                                                                                                                                               |

`agent.sandbox` gives direct access to the underlying `SandboxHandle` — `exec()`, `readFile()`,
`writeFile()`, etc. — independent of Pi.

## Properties

| Property             | Type            | Notes                                                  |
| -------------------- | --------------- | ------------------------------------------------------ |
| `agent.sandboxId`    | `string`        | OpenSandbox container ID                               |
| `agent.resourceRef`  | `ResourceRef`   | Durable memory scope (`resourceId`, optional `teamId`) |
| `agent.memory`       | `Memory?`       | Present when a `Memory` was passed in `opts`           |
| `agent.name`         | `string`        | Name from the spec                                     |
| `agent.sandbox`      | `SandboxHandle` | Underlying sandbox object                              |
| `agent.fromSnapshot` | `boolean`       | `true` when restored from cache                        |

Full reference: `packages/agent/README.md`.
