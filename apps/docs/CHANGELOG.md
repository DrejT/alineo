# docs

## 0.1.4

### Patch Changes

- fcc5b1b: Update the Cloudflare Pages project name references from `drej-docs` to `alineo-docs`,
  matching the project's rename on the Cloudflare dashboard. No behavior change other than
  `deploy-docs.yml` and `bun run deploy` now targeting the correct (renamed) project.

## 0.1.3

### Patch Changes

- 51b3ba5: Bump `next` (apps/docs) to 16.3.1 and `astro` (apps/sandbox, apps/registry) to ^7.2.2 to
  resolve 16 open Dependabot alerts (Next.js Server Action/edge runtime issues, Astro dev-toolbar
  and content-collection issues). Also drops a stale root `overrides.vite: "7.3.6"` pin — left
  over from an Astro 6-era Vite conflict fix — that was forcing an incompatible Vite 7 onto
  Astro 7 (which requires Vite ^8) and broke the registry/sandbox builds until removed. No source
  changes required; none of these apps use any of the APIs Astro 7 removed or changed. All three
  apps are `private: true` and not published, so no version bump is meaningfully consumed here
  (apps/sandbox and apps/registry have no `version` field and aren't tracked by changesets at
  all; apps/docs is listed only to satisfy the changeset-required check).

## 0.1.2

### Patch Changes

- 5055755: `AgentSpec.cliVersion` now actually pins the installed Pi CLI version. Previously it was only used as a setup-hash cache-key input — `install()` always ran `npm install -g @earendil-works/pi-coding-agent` with no version qualifier, so setting `cliVersion` had no effect on which version got installed. `install()` now runs `npm install -g @earendil-works/pi-coding-agent@<cliVersion>` when `cliVersion` is set (accepts an exact version, a semver range, or a dist-tag like `"latest"`), and falls back to the bare package name when omitted.

## 0.1.1

### Patch Changes

- cd88d21: Bump dev-dependencies group (@types/node, eslint, eslint-config-next, oxfmt, @flue/runtime) — no code changes.
- 18cbb28: Bump next to 16.2.10 (dependency patch update, no code changes).
- 1720e23: Bump react-dom to 19.2.7 (dependency patch update, no code changes).
- fd43649: Audited every .mdx page against the source code it documents and fixed 30+ mismatches: a systemic fabricated `client.connect()`/`client.close()` API (repeated across 7 files — `Drej` has neither), a completely rewritten `docs/drejx/` section (11 files — the CLI only manages local `AgentSpec` files, it never provisions sandboxes, checkpoints, or writes `.drej/sandboxes.json`, which is dead code), incorrect error-class docs (`SandboxError` vs `DrejError`), wrong `checkpoint()` return type, an incomplete `IStorageAdapter` transcription, wrong Postgres/SQLite schemas, fabricated `SandboxStatus` values, a wrong `searchFiles()` return type, a hand-rolled `execCode()` context example that doesn't work, fabricated `execCode()` options, incorrect `AgentEvent.compaction_end` types, an incomplete `compact()` return shape, `AgentSpec.cliVersion`/`.metadata`/`.registryDependencies` documented as functional when they're no-ops, and several smaller wording fixes (retry backoff math, `when()`'s cumulative-stdout semantics, a documented known limitation in concurrent `forEach`). No behavior changes — doc-only.
