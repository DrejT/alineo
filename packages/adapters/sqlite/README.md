# @alineo-labs/sqlite

SQLite storage adapter for [alineo](https://alineo.tech). Stores the sandbox ledger in a local `.db` file — zero infrastructure, works out of the box.

```bash
bun add @alineo-labs/sqlite
```

For production workloads that need durability across multiple processes or machines, use [`@alineo-labs/postgres`](https://github.com/DrejT/drej/tree/main/packages/adapters/postgres) instead.

---

## Usage

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: "http://localhost:8080",
  adapter: new SQLiteAdapter("./ledger.db"),
});
```

The adapter initialises lazily on first use — no `connect()` call needed. On process exit, `beforeExit` closes the connection automatically.

WAL mode is enabled by default for better concurrent read performance.

---

## License

Apache 2.0
