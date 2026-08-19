# Storage Adapters

### SQLiteAdapter (local dev)

```ts
import { SQLiteAdapter } from "@alineo-labs/sqlite";

// File-based (creates parent dirs automatically — safe on fresh checkout)
new SQLiteAdapter("./.alineo/ledger.db")

// In-memory (unit tests / throwaway scripts)
new SQLiteAdapter(":memory:")
```

- No `connect()` call needed — the adapter is lazily initialised on first use.
- `process.beforeExit` closes it automatically for scripts.
- Enables WAL mode internally (readers don't block writers).

#### Known Windows quirks with SQLiteAdapter

| Issue | Root cause | Fix already applied |
|---|---|---|
| `SQLITE_CANTOPEN` on first use | `bun:sqlite` doesn't create missing parent directories | `mkdirSync(dirname(path), { recursive: true })` in constructor — ignores `EEXIST` |
| `EBUSY`/`EPERM` during test cleanup | Windows file locks on open DB files during `rmSync` | `try/catch` in test `finally` block — ignores `EBUSY`/`EPERM` |

### PostgresAdapter (production)

```ts
import { PostgresAdapter } from "@alineo-labs/postgres";

new PostgresAdapter("postgresql://user:pass@host:5432/db")
```

Schema is idempotent `CREATE TABLE IF NOT EXISTS` — safe to run on every boot.
