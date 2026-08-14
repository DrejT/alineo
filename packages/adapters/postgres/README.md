# @alineo-labs/postgres

Postgres storage adapter for [alineo](https://alineo.tech). Stores the sandbox ledger in a Postgres database — suitable for production deployments where multiple processes or machines share the same ledger.

```bash
bun add @alineo-labs/postgres
```

For local development, [`@alineo-labs/sqlite`](https://github.com/DrejT/alineo/tree/main/packages/adapters/sqlite) is simpler and requires no infrastructure.

---

## Usage

```ts
import { Alineo } from "alineo";
import { PostgresAdapter } from "@alineo-labs/postgres";

const client = new Alineo({
  baseUrl: "http://localhost:8080",
  adapter: new PostgresAdapter("postgresql://user:pass@localhost:5432/alineo"),
});
```

The adapter initialises lazily on first use and runs idempotent migrations (`CREATE TABLE IF NOT EXISTS`) on startup — no separate migration step needed.

---

## License

Apache 2.0
