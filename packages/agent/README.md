# @alineo-labs/agent

Run [Pi](https://pi.ai) coding agents inside isolated [alineo](https://alineo.tech) sandbox containers. Pi can read and write files, run shell commands, and execute scripts — streamed back through a simple TypeScript API.

```bash
bun add @alineo-labs/agent
```

**[Full documentation →](https://docs.alineo.tech/docs/agent)**

---

## Quickstart

Create an agent spec (`agents/my-agent.json`):

```json
{
  "$schema": "https://registry.alineo.tech/spec/agent.json",
  "name": "my-agent",
  "cli": "pi",
  "model": "gemini-flash-latest",
  "packages": ["python3"],
  "env": { "GEMINI_API_KEY": "${GEMINI_API_KEY}" },
  "resources": { "cpu": "1000m", "memory": "2Gi" }
}
```

```ts
import { Agent, textOnly } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const agent = await Agent.load("./agents/my-agent.json", { adapter });
try {
  for await (const chunk of textOnly(agent.prompt("Write and run a Python hello world script."))) {
    process.stdout.write(chunk);
  }
} finally {
  await agent.close();
}
```

`opts.adapter` is required — `@alineo-labs/agent` has no storage-adapter dependency of its own, so you choose: `new SQLiteAdapter(path)` from `@alineo-labs/sqlite` for local dev, or `new PostgresAdapter(connectionString)` from `@alineo-labs/postgres` for production.

---

## Agent spec

The spec JSON controls the agent's environment, model, and workspace setup.

| Field        | Type                     | Description                                                                                    |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `name`       | `string`                 | Unique identifier, used as the sandbox session name                                            |
| `cli`        | `"pi"`                   | CLI to run (currently only `"pi"`)                                                             |
| `cliVersion` | `string?`                | Pin to a specific Pi version, e.g. `"0.80.2"`. Defaults to latest.                             |
| `model`      | `string?`                | Model ID passed to Pi via `--model`                                                            |
| `provider`   | `string?`                | AI provider passed via `--provider`. Omit for direct Google API key.                           |
| `packages`   | `string[]?`              | APT packages to install before Pi. e.g. `["git", "python3"]`                                   |
| `env`        | `Record<string,string>?` | Env vars in the sandbox. Values may reference host env: `"${MY_KEY}"`                          |
| `resources`  | `object?`                | CPU/memory limits: `{ cpu: "1000m", memory: "2Gi" }`                                           |
| `setup`      | `SetupStep[]?`           | Workspace setup steps (see below)                                                              |
| `spawnDepth` | `number?`                | Nesting-depth budget for `agent.spawn()` — see [Spawning child agents](#spawning-child-agents) |
| `maxAgents`  | `number?`                | Optional cap on total descendants for this lineage — see below                                 |

### Setup steps

`setup` runs bash commands after Pi CLI install, before the snapshot is taken. Changes to any step automatically invalidate the snapshot cache.

```json
{
  "name": "my-agent",
  "cli": "pi",
  "setup": [
    { "name": "Create workspace", "run": "mkdir -p /workspace" },
    { "name": "Install deps", "run": "npm install", "cwd": "/workspace" },
    { "name": "Seed data", "run": "node scripts/seed.js", "cwd": "/workspace" }
  ]
}
```

Each step:

| Field  | Type      | Description                                                       |
| ------ | --------- | ----------------------------------------------------------------- |
| `name` | `string`  | Human-readable label shown in logs and included in the setup hash |
| `run`  | `string`  | Bash command to execute                                           |
| `cwd`  | `string?` | Working directory. Runs as `cd <cwd> && <run>`                    |

---

## Snapshotting

On first load, `Agent.load()` installs the Pi CLI and any `setup` steps, then checkpoints the sandbox. Subsequent loads restore from that snapshot — skipping the install entirely.

```
Load 1 (cold):   sandbox → Pi install → setup steps → checkpoint → bridge   ~50s
Load 2 (warm):   snapshot restore → bridge                                   ~5s
```

The snapshot is invalidated automatically when `cli`, `cliVersion`, `packages`, or `setup` change.

```ts
// adapter: an IStorageAdapter — SQLiteAdapter or PostgresAdapter, see Quickstart
const agent = await Agent.load("./agents/my-agent.json", { adapter });
console.log(agent.fromSnapshot); // false on first load, true after

// Force a full reinstall:
const agent = await Agent.load("./agents/my-agent.json", { adapter, rebuild: true });
```

---

## Streaming

`agent.prompt()` and `agent.bash()` return an `AgentStream` — an `AsyncIterable<AgentEvent>`:

```ts
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "extension_ui"; method: string; params: unknown; isDialog: boolean; requestId?: string }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }
  | { type: "turn_start"; turnIndex: number; timestamp: number }
  | { type: "turn_end"; turnIndex: number; message: unknown; toolResults: unknown[] }
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown; delta: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason: string;
      result: object | null;
      aborted: boolean;
      willRetry: boolean;
    }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };
```

Use `textOnly()` to filter to just the text chunks (equivalent to the old `PromptStream` behavior):

```ts
import { Agent, textOnly } from "@alineo-labs/agent";

for await (const chunk of textOnly(agent.prompt("Summarise this repo."))) {
  process.stdout.write(chunk);
}
```

### Tool call observability

Iterate the raw stream to see every tool Pi uses:

```ts
for await (const ev of agent.prompt("Run /workspace/script.py with python3.")) {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "tool_start":
      console.log(`[tool] ${ev.toolName} args=${JSON.stringify(ev.args)}`);
      break;
    case "tool_end":
      console.log(`[tool] ${ev.toolName} done  isError=${ev.isError}`);
      break;
  }
}
```

---

## API reference

### Loading and lifecycle

#### `Agent.load(specPath, opts)`

Load a spec, spin up a sandbox, install Pi, run setup steps, and return a ready `Agent`. Restores from snapshot on subsequent calls. `opts.adapter` is required (see [Quickstart](#quickstart)).

```ts
const agent = await Agent.load("./agents/my-agent.json", { adapter });
const agent = await Agent.load("./agents/my-agent.json", { adapter, rebuild: true });
```

#### `Agent.resume(sandboxId, opts)`

Reconnect to an existing sandbox after the host process has exited. Only restarts the bridge — Pi and the workspace are untouched. `opts.adapter` is required.

```ts
// Original process saved agent.sandboxId somewhere...
const agent = await Agent.resume(savedSandboxId, { adapter });
// Or provide the spec explicitly:
const agent = await Agent.resume(savedSandboxId, { adapter, specPath: "./agents/my-agent.json" });
```

#### `Agent.attach(sandboxId, opts)`

Connect to an already-running sandbox **without** touching its Pi bridge — unlike `resume()`, which kills and restarts the bridge process. Use this when you only need `.spawn()`/`.sandbox`, not `.prompt()`/`.bash()` (the returned `Agent` has no bridge, so those throw).

The main caller is `alineo fork`: it runs as a fresh CLI process started BY the very Pi bash-tool call it's attaching to (a session forking a child from inside its own turn) — going through `resume()` there would kill the bridge currently running the call itself.

```ts
const self = await Agent.attach(process.env.ALINEO_SANDBOX_ID!, {
  adapter,
  name: "my-session",
});
const child = await self.spawn("./agents/worker.json");
```

#### `agent.close()`

Stop the sandbox container and release all resources. Always call in a `finally` block.

---

### Spawning child agents

#### `agent.spawn(childSpecPath, opts?)`

Fork **this agent's own live sandbox** — filesystem, installed packages, checked-out state, everything currently on disk — into a brand-new independent sandbox running its own Pi bridge. Unlike `Agent.load()` (always starts from a spec's own snapshot) or `fork()`/`clone()` (Pi's own conversation-branching — same container, same bridge, new session branch), this is sandbox-level forking: the child sees exactly what this agent's sandbox sees right now, including uncommitted work. No install/setup steps run — the child inherits whatever is already installed on this agent's sandbox.

```ts
const child = await agent.spawn("./agents/worker.json", { spawnDepth: 2, maxAgents: 5 });
try {
  for await (const chunk of textOnly(child.prompt("Handle the auth module"))) {
    process.stdout.write(chunk);
  }
} finally {
  await child.close();
}
```

Refuses immediately unless this agent's own spawn-depth budget (`spawnDepth` in the spec, or `opts.spawnDepth` to override) is a positive integer — `0` means no budget left, `undefined` means spawning was never enabled. Each spawn force-decrements the budget (`current - 1`) into the child's env, regardless of what the child's own spec says.

`maxAgents` (spec field or `opts.maxAgents`) is a separate, optional ceiling on total descendants for this lineage, independent of nesting depth. Unset means uncapped for this dimension — only `spawnDepth` gates whether spawning is allowed at all. **Not** coordinated across sibling branches spawned in parallel; it's a per-lineage counter.

---

### Streaming

#### `agent.prompt(message, opts?)`

Send a message to Pi and stream the response as `AgentStream`.

```ts
for await (const chunk of textOnly(agent.prompt("Explain this file."))) {
  process.stdout.write(chunk);
}
```

#### `agent.bash(command)`

Run a shell command inside Pi's working context and stream stdout as `AgentStream`.

```ts
for await (const chunk of textOnly(agent.bash("ls -la /workspace"))) {
  process.stdout.write(chunk);
}
```

---

### Mid-flight control

#### `agent.steer(message)`

Redirect Pi's current response mid-flight. Pi acknowledges and adjusts.

```ts
const stream = textOnly(agent.prompt("Write an essay on every sorting algorithm..."));
setTimeout(() => agent.steer("Stop — give me 3 bullet points instead."), 1500);
for await (const chunk of stream) process.stdout.write(chunk);
```

#### `agent.followUp(message)`

Queue a message for Pi to process after it finishes the current task.

#### `agent.abort()`

Interrupt the current in-progress response immediately.

---

### Session management

#### `agent.newSession()`

Start a fresh Pi conversation, clearing all context. Filesystem and workspace are unchanged.

#### `agent.clone()`

Branch the current Pi session at the current position. Returns `{ cancelled: boolean }`.

#### `agent.fork(entryId)`

Branch from a specific message entry in the conversation history. Returns `{ text, cancelled }`.

#### `agent.switchSession(sessionPath)`

Switch Pi to a different session file on disk.

#### `agent.getMessages()`

Retrieve the full conversation history for the current session.

```ts
const messages = await agent.getMessages();
console.log(messages.length, "messages");
```

---

### Model control

#### `agent.setModel(provider, modelId)`

Switch Pi to a specific model. Returns the activated `PiModel`.

#### `agent.cycleModel()`

Cycle to the next configured model. Returns `{ model, thinkingLevel, isScoped }` or `null` if only one model is configured.

#### `agent.getAvailableModels()`

List all models available to Pi under the current provider configuration.

#### `agent.setThinkingLevel(level)`

Set Pi's reasoning level (`"low" | "medium" | "high"`). Only effective on models that support extended thinking.

#### `agent.cycleThinkingLevel()`

Cycle Pi's thinking level. Returns `{ level }` or `null` if the current model doesn't support thinking.

---

### Context management

#### `agent.setAutoCompaction(enabled)`

Enable or disable Pi's automatic context compaction.

#### `agent.compact(customInstructions?)`

Manually trigger Pi's context compaction. Returns `{ tokensBefore, estimatedTokensAfter }`.

---

### Reliability

#### `agent.setAutoRetry(enabled)`

Enable or disable Pi's automatic retry on transient errors (429, 500, 502, 503, 504). Auto-retry is **on by default**: 3 attempts with exponential backoff (2 s / 4 s / 8 s). Disable it when you want to handle failures yourself via `auto_retry_start` / `auto_retry_end` events.

```ts
await agent.setAutoRetry(false); // take full control
```

#### `agent.abortRetry()`

Abort an in-progress auto-retry immediately. Pi fails the current operation and emits `auto_retry_end` with `success: false`.

#### `agent.abortBash()`

Abort a currently-executing bash command without cancelling the whole prompt. No-op when no bash is running.

---

### Session inspection

#### `agent.getSessionStats()`

Retrieve token usage, cost, and message counts for the current session. Returns a `SessionStats` object.

```ts
const stats = await agent.getSessionStats();
console.log(`${stats.tokens.total} tokens used, $${stats.cost.toFixed(6)} cost`);
```

#### `agent.getLastAssistantText()`

Retrieve the text of Pi's most recent assistant response without iterating the stream. Returns `null` if Pi hasn't responded yet.

#### `agent.getForkMessages()`

List the fork entry points available in the current session. Each entry has `entryId` (pass to `fork()`) and `text`.

#### `agent.getCommands()`

List Pi's available slash commands, including extensions, prompt templates, and skills. Returns `PiSlashCommand[]`.

```ts
const cmds = await agent.getCommands();
for (const cmd of cmds) console.log(`/${cmd.name} [${cmd.source}]`);
```

#### `agent.setSessionName(name)`

Set a display name for the current Pi session.

#### `agent.exportHtml(outputPath?)`

Export a static HTML transcript of the session to the sandbox filesystem. Returns `{ path }` — the container path of the file. Use `agent.sandbox.readFile(path)` to retrieve it.

```ts
const { path } = await agent.exportHtml();
const html = await agent.sandbox.readFile(path);
```

---

### Advanced control

#### `agent.setSteeringMode(mode)`

Control how Pi processes queued steering messages: `"all"` applies all at once, `"one-at-a-time"` applies them sequentially.

#### `agent.setFollowUpMode(mode)`

Control how Pi processes queued follow-up messages: `"all"` sends all at once, `"one-at-a-time"` sends them sequentially.

---

### Environment and debugging

#### `agent.setEnv(vars)`

Set or update env vars in the running container. Restarts Pi so it picks up the new env.

```ts
await agent.setEnv({ DATABASE_URL: "postgres://..." });
```

#### `agent.getLogs()`

Retrieve recent bridge logs (ring-buffered, last 200 entries).

#### `agent.sandbox`

Direct access to the underlying `Sandbox` — run commands, read/write files, or inspect state independently of Pi.

```ts
await agent.sandbox.writeFile("/workspace/input.txt", data);
const { stdout } = await agent.sandbox.exec("wc -l /workspace/input.txt");
const result = await agent.sandbox.readFile("/workspace/output.txt");
```

---

## Properties

| Property             | Type      | Description                                    |
| -------------------- | --------- | ---------------------------------------------- |
| `agent.sandboxId`    | `string`  | OpenSandbox container ID                       |
| `agent.name`         | `string`  | Agent name from the spec                       |
| `agent.sandbox`      | `Sandbox` | Underlying alineo `Sandbox` object             |
| `agent.fromSnapshot` | `boolean` | `true` when restored from snapshot (fast path) |

---

## License

Apache 2.0
