# Development, Testing & Release

## Testing

### Unit tests (no server needed)

```bash
bun run test                      # all packages
bun test packages/adapters/sqlite # one package
bunx tsc --noEmit --strict --project packages/<name>/tsconfig.json  # typecheck one package
```

Use `new SQLiteAdapter(":memory:")` — fast, zero-disk, no cleanup.

**Test lifecycle pattern:**

```ts
import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

let db: SQLiteAdapter;
beforeEach(async () => {
  db = new SQLiteAdapter(":memory:");
  await db.connect();
});
afterEach(async () => {
  await db.close();
});
```

### Integration tests (server required)

```bash
bun run test:integration               # all
cd tests/integration && bun test <name>.test.ts  # one file
```

Requires OpenSandbox running locally. Integration test client setup:

```ts
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  adapter: new SQLiteAdapter(":memory:"),
  useServerProxy: true,
});
```

Always wrap the sandbox in `try/finally { await sb.close(); }` — avoids
container leaks and ensures `sandbox_closed` is written to the ledger.

Assert on observable behaviour, not internals:

```ts
const { stdout, exitCode } = await sb.exec("echo hello");
expect(exitCode).toBe(0);
expect(stdout.trim()).toBe("hello");
```

## Adding a New Example

```bash
# Scaffold example + matching integration test stub
bun scripts/new-example.ts <name>
# then implement:
#   examples/<name>/index.ts
#   tests/integration/<name>.test.ts
```

## Build & Release

```bash
bun run build         # build all packages (tsdown, topologically sorted)
bun run typecheck     # tsc --noEmit across all packages
bunx changeset        # add a changeset (required on every PR touching publishable packages)
bunx changeset status # verify a changeset exists before pushing
```

> **Changesets must be committed** — `bunx changeset status --since origin/main` reads
> from git history, not disk. An uncommitted `.changeset/*.md` will not satisfy CI.

## Verification Checklist

Before committing work on this repo:

- [ ] `bun run test` — all unit tests pass
- [ ] `bun run typecheck` — no TypeScript errors
- [ ] `bun run build` — all packages build cleanly
- [ ] Integration test if touching sandbox lifecycle: `bun run test:integration`
- [ ] Changeset added if touching any publishable package: `bunx changeset`
- [ ] Changeset committed (not just staged): `bunx changeset status --since origin/main`
