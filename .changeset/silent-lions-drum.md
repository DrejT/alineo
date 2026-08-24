---
---

Internal only, no publishable package changes: fix `bun run typecheck` (`scripts/workspace-run.ts`)
so it builds every `packages/**` workspace before typechecking it, then swap CI's hand-maintained
per-package `tsc` chain in `.github/workflows/ci.yml` for that single `bun run typecheck` step.

`typecheck` resolves cross-package `workspace:*` imports against each dependency's built `types`
entry point (e.g. `opensandbox`'s `package.json` points `types` at `dist/index.d.mts`), not its
source, so a package that hadn't been built yet was unresolvable to anything depending on it —
`core`'s own typecheck failed with `Cannot find module '@alineo-labs/opensandbox'` when run on a
clean checkout. CI never hit this because its old hardcoded chain always ran after a separate
"Build all packages" step, which is also exactly how it stayed hidden that the chain itself was
missing `packages/model-providers`, `packages/adapters/flue`, `packages/agent-browser`, and
`packages/harness` — none of those were getting typechecked in CI at all (see #199/#201, where
this gap let two `@ai-sdk/*` major bumps show green CI despite failing `tsc --noEmit --strict`).

Verified: clean checkout, `bun run typecheck` now passes standalone with no prior build step, and
covers all 13 `packages/**` workspaces including the 4 that were previously silently skipped.
Full CI job simulated locally end to end (build, typecheck packages, typecheck sandbox, lint,
format check, tests) — all green, no new warnings.

Closes #201.
