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

**[Full documentation →](https://docs.alineo.tech)**

---

## Cookbook

Task-oriented recipes for real end-to-end scenarios — untrusted code execution, parallel test
sharding, resumable pipelines, and more — built by composing sandboxes, exec, checkpoints, forks,
and agents. Each one is a small, standalone package you can copy out and adapt.

**[Browse the cookbook →](cookbooks)**

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
