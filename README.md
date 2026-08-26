# alineo

[![CI](https://github.com/DrejT/alineo/actions/workflows/ci.yml/badge.svg)](https://github.com/DrejT/alineo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alineo)](https://www.npmjs.com/package/alineo)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/XGkPu3YBH4)

Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.

<!-- TODO: demo GIF/video — drop in here once recorded -->

```ts
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: "http://127.0.0.1:8080",
  adapter: new SQLiteAdapter("./ledger.db"),
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
});
await sb.exec('echo "hello from a sandbox"').pipe(process.stdout);
await sb.close();
```

---

## What you can build

**Run untrusted code safely** — every snippet gets its own disposable, resource-capped sandbox, and
a bad one can't take down the batch:

```ts
const sb = await client.sandbox({
  image: "python:3.11-slim",
  resources: { cpu: "250m", memory: "128Mi" },
  timeout: 60,
});
await sb.writeFile("/tmp/snippet.py", untrustedCode);
const { stdout, exitCode } = await sb.exec("python3 /tmp/snippet.py", {
  strict: false, // a non-zero exit comes back as data, not a throw
  timeoutMs: 5_000, // kill a runaway loop instead of hanging the batch
});
await sb.close();
```

**[Full recipe →](cookbooks/untrusted-code-execution)**

**Fan out across sandboxes in parallel** — one pipeline, several environments, flushed in a single
`await`:

```ts
import { workflow } from "@alineo-labs/workflow";

await workflow(client)
  .parallel(
    [
      { image: "node:18-slim", resources: { cpu: "500m", memory: "256Mi" } },
      { image: "node:20-slim", resources: { cpu: "500m", memory: "256Mi" } },
    ],
    (sb) => sb.exec("npm ci && npm test"),
  )
  .pipe(process.stdout);
```

**[`@alineo-labs/workflow` docs →](packages/workflow)**

**Run a coding agent inside a sandbox** — [Pi](https://pi.ai) reads and writes files and runs shell
commands, streamed back over a plain TypeScript API:

```ts
import { Alineo, textOnly } from "alineo";

const spec = await Bun.file("./agents/my-agent.json").json(); // { cli: "pi", model, resources, ... }
const agent = await Alineo.load(spec, { adapter });
for await (const chunk of textOnly(agent.prompt("Fix the failing test in src/math.ts"))) {
  process.stdout.write(chunk);
}
await agent.close();
```

**[`alineo` agent docs →](packages/agent)**

**[Full documentation →](https://docs.alineo.tech)**

---

## Cookbook

More task-oriented recipes for real end-to-end scenarios — CI test runners, parallel test
sharding, resumable pipelines, LLM bugfix agents, and more — built by composing sandboxes, exec,
checkpoints, forks, and agents. Each one is a small, standalone package you can copy out and adapt.

**[Browse the cookbook →](cookbooks)**

---

## Packages

Full reference — every package above lives here, plus the storage adapters and CLI:

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

## Windows Support

This repo features native cross-platform support and can be developed directly on Windows without requiring WSL or Git Bash.
- **Native Scripts**: All repository scripts (e.g., `bun run setup`, `bun run build`) leverage Bun's native shell APIs.
- **Docker Integration**: The local `alineo init` command dynamically detects Windows and uses Named Pipes (`//./pipe/docker_engine`) for Docker socket injection automatically.

---

## Community

- **Discord**: [Join us](https://discord.com/invite/XGkPu3YBH4) — questions, discussion, and help in real time
- **Issues**: [Report a bug](https://github.com/DrejT/alineo/issues) or request a feature
- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

Apache 2.0
