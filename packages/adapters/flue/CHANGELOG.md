# @drej/flue

## 1.0.1

### Patch Changes

- 84b7862: Internal: enabled Oxlint's type-aware linting repo-wide and fixed every finding it surfaced
  (681 → 0). Almost entirely non-behavioral (removing unnecessary type assertions, replacing
  non-null assertions with real invariant checks, fixing tsconfig gaps that were masking latent
  type errors) — flagged the couple of exceptions below since they do change observable behavior.

  - `alineo-cli`'s Pi bootstrap extension (`pi-extension/alineo.ts`) no longer replaces an
    empty-but-present `stderr` string with a generic fallback message in its install/init failure
    notifications — only a genuinely missing `stderr` falls back now.
  - `@alineo-labs/core`'s `SandboxCore` gained a couple of small correctness fixes surfaced along the
    way: `bun:sqlite`'s deprecated `exec()` alias replaced with `run()`, and a `finally`-block cleanup
    path in a test that could previously mask a real assertion failure with an unrelated error now
    logs instead of throwing.
  - `packages/cli/src/tui/chat.ts`'s `AgentEvent` switch now lists all 14 previously-implicit
    "ignored" event kinds explicitly instead of a bare `default`, so a future new event kind fails
    exhaustiveness and forces a conscious decision, rather than silently landing in "ignored".

  No public API changes. Full `typecheck`/`test`/`build` suite passes for every package.

## 1.0.0

### Minor Changes

- d628de4: **Breaking:** the `peerDependencies` entry `alineo` is renamed to `@alineo-labs/sandbox`, per the
  naming inversion in [#182](https://github.com/DrejT/alineo/issues/182) — install
  `@alineo-labs/sandbox` instead of `alineo` alongside this package. `alineo(sandbox, opts)`'s
  `sandbox` parameter is now typed as `SandboxHandle` from `@alineo-labs/sandbox` (was `Sandbox`
  from `alineo`); any object satisfying the same shape still works, this only affects callers who
  import the type name explicitly. `alineo(sandbox, opts)`'s own behavior is unchanged.

### Patch Changes

- Updated dependencies [d628de4]
  - @alineo-labs/sandbox@0.2.0

## 0.1.0

### Major Changes

- 2a61e0c: Rename the project from drej to alineo. Breaking change: every published package's name
  changed.

  - SDK: `drej` → `alineo` (`import { Drej } from "drej"` → `import { Alineo } from "alineo"`).
    `DrejError`/`DrejOptions` → `AlineoError`/`AlineoOptions`.
  - CLI: `drejx` → `alineo-cli` (npm package name), binary command `drejx` → `alineo`
    (`drejx init` → `alineo init`, etc). `~/.config/drejx/` → `~/.config/alineo/`,
    project-local `drej.config.json` → `alineo.config.json`, `.drej/` → `.alineo/`.
  - Scoped packages: `@drej/*` → `@alineo-labs/*` across all 14 previously-scoped packages.
  - Environment variables: `DREJ_*`/`DREJX_*` → `ALINEO_*` (the two-prefix split collapses to
    one now that the CLI binary and SDK class share the same root name).

  This is a code-level rename only — package/CLI/env-var/config-path identifiers. GitHub
  org/repo, deploy domains, and Cloudflare project names are unchanged in this pass (that
  infra isn't provisioned under the new name yet).

### Patch Changes

- bd95393: Remove `private: true` from the 10 publishable packages so they can actually be published to
  npm. No functional or API changes — this is the last step of npm-publish readiness (repository
  URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.
- Updated dependencies [bd95393]
- Updated dependencies [2a61e0c]
- Updated dependencies [637b678]
- Updated dependencies [acc51e3]
  - alineo@1.0.0

## 3.0.0

### Patch Changes

- Updated dependencies [13b826b]
- Updated dependencies [fa18120]
  - drej@0.10.0

## 2.0.3

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

- Updated dependencies [a4856f1]
  - drej@0.9.3

## 2.0.2

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

- Updated dependencies [a91651c]
  - drej@0.9.2

## 2.0.1

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- cd88d21: Bump dev-dependencies group (@types/node, eslint, eslint-config-next, oxfmt, @flue/runtime) — no code changes.
- 3f362d1: Enable npm provenance for published packages.
- Updated dependencies [34cfa8b]
- Updated dependencies [bca2a6b]
- Updated dependencies [3f362d1]
  - drej@0.9.1

## 2.0.0

### Patch Changes

- Updated dependencies [a0c1eee]
- Updated dependencies [f803858]
- Updated dependencies [c81c77d]
  - drej@0.9.0

## 1.0.0

### Minor Changes

- 9c238d6: Add `@drej/flue` — Flue sandbox adapter that wraps a drej `Sandbox` as a Flue `SandboxFactory`. Implements the full `SandboxApi` interface (`exec`, `readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`) backed by drej sandbox exec and file operations.

### Patch Changes

- Updated dependencies [10417e3]
- Updated dependencies [5a63143]
- Updated dependencies [416bc72]
- Updated dependencies [f83ccf2]
- Updated dependencies [0398728]
- Updated dependencies [4f79c8e]
- Updated dependencies [2ed4de7]
- Updated dependencies [02bcb01]
- Updated dependencies [2bbd8dc]
- Updated dependencies [599d707]
  - drej@0.8.0
