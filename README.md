# alineo

[![CI](https://github.com/DrejT/alineo/actions/workflows/ci.yml/badge.svg)](https://github.com/DrejT/alineo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alineo)](https://www.npmjs.com/package/alineo)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/XGkPu3YBH4)

Run [Pi](https://pi.ai) coding agents inside isolated sandbox containers — read/write files, run
shell commands, execute scripts, streamed back over a plain TypeScript API.

<!-- TODO: demo GIF/video — drop in here once recorded -->

```ts
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const spec = await Bun.file("./agents/my-agent.json").json();
const agent = await Alineo.load(spec, { adapter });
try {
  for await (const chunk of textOnly(agent.prompt("Write and run a Python hello world script."))) {
    process.stdout.write(chunk);
  }
} finally {
  await agent.close();
}
```

**[Full documentation →](https://docs.alineo.tech/docs/agent)**

---

**Watch every tool call** — iterate the raw stream instead of `textOnly()` for full observability:

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

**Spawn child agents** — fork this agent's live sandbox (filesystem, installed packages,
everything currently on disk) into an independent sub-agent:

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

**Steer mid-response** — redirect Pi while it's still generating, no need to wait or restart:

```ts
const stream = textOnly(agent.prompt("Write an essay on every sorting algorithm..."));
setTimeout(() => agent.steer("Stop — give me 3 bullet points instead."), 1500);
for await (const chunk of stream) process.stdout.write(chunk);
```

**Resume after a restart** — reconnect to a sandbox from a previous process without touching Pi's
running state:

```ts
const agent = await Alineo.resume(savedSandboxId, { adapter });
```

**Inspect session cost and usage**:

```ts
const stats = await agent.getSessionStats();
console.log(`${stats.tokens.total} tokens used, $${stats.cost.toFixed(6)} cost`);
```

**[More in the agent docs →](packages/agent)**

---

## Packages

| Package                                                 | Description                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| [`@alineo-labs/sandbox`](packages/sdks/typescript)         | Sandbox client — `Sandbox`, `SandboxHandle`, `ExecHandle`    |
| [`@alineo-labs/workflow`](packages/workflow)               | Lazy pipeline builder — retry, branching, fan-out, parallel |
| [`alineo`](packages/agent)                                 | Run Pi coding agents in sandbox containers                  |
| [`@alineo-labs/sqlite`](packages/adapters/sqlite)          | SQLite storage adapter (local dev, zero infra)              |
| [`@alineo-labs/postgres`](packages/adapters/postgres)      | Postgres storage adapter (production)                       |
| [`@alineo-labs/otel`](packages/adapters/otel)              | OpenTelemetry hooks adapter                                 |
| [`@alineo-labs/flue`](packages/adapters/flue)              | Flue runtime adapter — run Flue workflows against a `SandboxHandle` |
| [`alineo-cli`](packages/cli)                               | CLI — local OpenSandbox setup, spec management, agent session lifecycle |

---

## Local setup

alineo runs sandboxes against an [OpenSandbox](https://open-sandbox.ai) instance. The fastest way to get one locally:

```bash
bunx alineo-cli init
```

Or run the server directly with `uvx opensandbox-server` — see [`alineo-cli`](packages/cli) for details.

---

## Agent Skills

Alineo ships a `SKILL.md` at `.agents/skills/alineo/` — a curated reference for the SDK, CLI, and
storage adapters that AI coding agents can load directly. Install it with the
[Skills CLI](https://skills.sh) (`npx skills`), the open package manager for agent skills:

```bash
npx skills add DrejT/alineo --skill alineo
```

---

## Community

- **Discord**: [Join us](https://discord.com/invite/XGkPu3YBH4) — questions, discussion, and help in real time
- **Issues**: [Report a bug](https://github.com/DrejT/alineo/issues) or request a feature
- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

Apache 2.0
