# @alineo-labs/agent-browser

## 0.2.0

### Minor Changes

- 4fd2313: Add `b.inspect({ mask })` (page structure, masked by default), `browserEnv()` + `b.setup()` (pinned user agent, viewport, locale, timezone, timeout, tab, input mode, blocked analytics hosts), `b.har.start/stop/summary` (find a site's endpoints without recording values), and `b.session.dump/save/load/request` (call a site's API with the browser's session, from a session file inside the sandbox, with no browser running). `saveSession`/`loadSession` are deprecated in favour of `b.session.save`/`b.session.load`.
- 93879a4: Publish the package to npm. Add `browser()` command builders for deterministic workflows, `browserOk`/`parseBrowserResult` for agent-browser's `--json` envelope, and `saveSession`/`loadSession` to move a signed-in browser session between sandboxes as bytes.

  `browserSetupSteps()` now pins agent-browser (`AGENT_BROWSER_VERSION`, default `0.43.0`; override with `{ version }`), and no longer runs `agent-browser install --with-deps` next to its own `apt-get`. Current agent-browser runs `apt-get` itself for `--with-deps`, and the two failed on the dpkg lock.

## 0.1.4

### Patch Changes

- Updated dependencies [87a9c39]
- Updated dependencies [87a9c39]
- Updated dependencies [c4e64df]
  - @alineo-labs/core@0.4.0

## 0.1.3

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

- Updated dependencies [f987d00]
- Updated dependencies [223390e]
- Updated dependencies [84b7862]
  - @alineo-labs/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [d628de4]
  - @alineo-labs/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [a9564e1]
- Updated dependencies [b03ae19]
- Updated dependencies [7acdf32]
- Updated dependencies [bd95393]
- Updated dependencies [2a61e0c]
- Updated dependencies [637b678]
- Updated dependencies [acc51e3]
  - @alineo-labs/core@1.0.0
