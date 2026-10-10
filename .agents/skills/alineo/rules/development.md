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
cd tests/integration && bun test <name>.test.ts  # one file, e.g. agent.test.ts
```

Requires OpenSandbox running locally. Agent integration test setup:

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const agent = await Alineo.start(specPath, { adapter: new SQLiteAdapter("./.alineo/ledger.db") });
```

Always close the agent in `afterAll`/`finally` — avoids container leaks and ensures
`sandbox.closed` is written to the ledger.

Tests read `OPEN_SANDBOX_SERVER_PROXY` (default **on**, because an `alineo init` server hands out
container-internal endpoints the host can't reach). Set it to `false` for a bare
`uvx opensandbox-server`.

**Testing a branch's CLI:** specs that spawn children do `npm install -g alineo-cli`, which pulls
npm's version, not your checkout's. Use `bun scripts/local-cli-spec.ts <spec.json> [out.json]` to
rewrite a spec to install the local build.

**Pinning an NVIDIA model:** answering `/v1/chat/completions` is not the bar — a reasoning model
that streams nothing while it thinks trips alineod's 180 s prompt-inactivity timeout and the turn
comes back empty. Re-measure with `bun apps/alineod/scripts/probe-models.ts <model...>`, several
samples (the failure is intermittent).

Assert on observable behaviour, not internals:

```ts
const { stdout, exitCode } = await agent.sandbox.exec("echo hello");
expect(exitCode).toBe(0);
expect(stdout.trim()).toBe("hello");
```

> **Never hardcode a real API key in a test file** — read it from `process.env` and document the
> env var in the test's header comment. A committed literal key is a leaked secret the moment it
> lands on a public remote.

## Adding a New Example

```bash
# Scaffold example + matching integration test stub
bun scripts/new-example.ts <name>
# then implement:
#   examples/<name>/index.ts
#   tests/integration/<name>.test.ts
```

## Docs

`apps/docs/content/docs/` is **unversioned** — edit pages in place (the `vX.Y` folders and
`cut-doc-version.ts` were removed in #232). Layout per product: `index.mdx`, `quickstart.mdx`,
`concepts/`, `api-reference/`. Snippets must come from `packages/*/src`, not from another page.
Don't claim ahead of the durability roadmap: "resumable to the last completed turn" is proved,
"durable" is not.

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
- [ ] `bun run check:vocabulary` — CLI/MCP/HTTP/event names agree, every spec validates
- [ ] `bun run check:dead-code` — fallow; removing dead code is **its own commit**, never mixed into a feature
- [ ] `bun run check:docs-links` if you moved or renamed a docs page (add a `_redirects` rule, one hop)
- [ ] Integration test if touching sandbox lifecycle: `bun run test:integration`
- [ ] Changeset added if touching any publishable package: `bunx changeset`
- [ ] Changeset committed (not just staged): `bunx changeset status --since origin/main`
