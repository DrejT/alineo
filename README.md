# drej

[![CI](https://github.com/DrejT/drej/actions/workflows/ci.yml/badge.svg)](https://github.com/DrejT/drej/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/drej)](https://www.npmjs.com/package/drej)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.

```ts
import { Drej } from "drej";
import { SQLiteAdapter } from "@drej/sqlite";

const client = new Drej({
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

**[Full documentation →](https://docs.drej.dev)**

---

## Packages

| Package                                        | Description                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [`drej`](packages/sdks/typescript)             | Core SDK — `Drej` client, `Sandbox`, `ExecHandle`           |
| [`@drej/workflow`](packages/workflow)          | Lazy pipeline builder — retry, branching, fan-out, parallel |
| [`@drej/agent`](packages/agent)                | Run Pi coding agents in sandbox containers                  |
| [`@drej/sqlite`](packages/adapters/sqlite)     | SQLite storage adapter (local dev, zero infra)              |
| [`@drej/postgres`](packages/adapters/postgres) | Postgres storage adapter (production)                       |
| [`@drej/otel`](packages/adapters/otel)         | OpenTelemetry hooks adapter                                 |
| [`@drej/flue`](packages/adapters/flue)         | Flue runtime adapter — run Flue workflows against a drej `Sandbox` |
| [`drejx`](packages/cli)                        | CLI — local OpenSandbox setup, spec management, agent session lifecycle |

---

## Local setup

drej runs sandboxes against an [OpenSandbox](https://open-sandbox.ai) instance. The fastest way to get one locally:

```bash
bunx drejx init
```

Or run the server directly with `uvx opensandbox-server` — see [`drejx`](packages/cli) for details.

---

## Windows Support

`drej-private` features native cross-platform support and can be developed directly on Windows without requiring WSL or Git Bash.
- **Native Scripts**: All repository scripts (e.g., `bun run setup`, `bun run build`) leverage Bun's native shell APIs.
- **Docker Integration**: The local `drejx init` command dynamically detects Windows and uses Named Pipes (`//./pipe/docker_engine`) for Docker socket injection automatically.

---

## License

Apache 2.0
