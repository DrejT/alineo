# @alineo-labs/model-providers

## 0.1.2

### Patch Changes

- 7380c08: Swap the default NVIDIA NIM embedding model from `nvidia/nv-embedqa-e5-v5` to
  `nvidia/nemotron-3-embed-1b`. The old model reached end of life on 2026-08-25 and now returns
  `410 Gone` from `integrate.api.nvidia.com`, breaking every `createNvidiaEmbeddingProvider()`
  caller that relied on the default (notably `@alineo-labs/memory`'s semantic memory).

  Note: the new model emits **2048-dim** vectors (was 1024). The memory adapters size their
  vector tables lazily from the first embedding seen, so fresh stores are fine, but any
  persisted semantic-memory store created with the old default must be re-embedded.

## 0.1.1

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
