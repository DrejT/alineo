# alineo

[![CI](https://github.com/DrejT/drej/actions/workflows/ci.yml/badge.svg)](https://github.com/DrejT/drej/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alineo)](https://www.npmjs.com/package/alineo)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
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

## Packages

| Package                                                 | Description                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| [`alineo`](packages/sdks/typescript)                      | Core SDK — `Alineo` client, `Sandbox`, `ExecHandle`           |
| [`@alineo-labs/workflow`](packages/workflow)               | Lazy pipeline builder — retry, branching, fan-out, parallel |
| [`@alineo-labs/agent`](packages/agent)                     | Run Pi coding agents in sandbox containers                  |
| [`@alineo-labs/sqlite`](packages/adapters/sqlite)          | SQLite storage adapter (local dev, zero infra)              |
| [`@alineo-labs/postgres`](packages/adapters/postgres)      | Postgres storage adapter (production)                       |
| [`@alineo-labs/otel`](packages/adapters/otel)              | OpenTelemetry hooks adapter                                 |
| [`@alineo-labs/flue`](packages/adapters/flue)              | Flue runtime adapter — run Flue workflows against an alineo `Sandbox` |
| [`alineo-cli`](packages/cli)                               | CLI — local OpenSandbox setup, spec management, agent session lifecycle |

---

## Local setup

alineo runs sandboxes against an [OpenSandbox](https://open-sandbox.ai) instance. The fastest way to get one locally:

```bash
bunx alineo-cli init
```

Or run the server directly with `uvx opensandbox-server` — see [`alineo-cli`](packages/cli) for details.

---

## Windows Support

This repo features native cross-platform support and can be developed directly on Windows without requiring WSL or Git Bash.
- **Native Scripts**: All repository scripts (e.g., `bun run setup`, `bun run build`) leverage Bun's native shell APIs.
- **Docker Integration**: The local `alineo init` command dynamically detects Windows and uses Named Pipes (`//./pipe/docker_engine`) for Docker socket injection automatically.

---

## License

Apache 2.0
