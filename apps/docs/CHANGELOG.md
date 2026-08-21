# docs

## 0.2.0

### Minor Changes

- b561f8b: Add versioned docs for the Core SDK (`alineo`) and CLI (`alineo-cli`) sections. Content for
  both now lives under a `v0.1` folder (`/docs/core/v0.1/...`, `/docs/alineo/v0.1/...`), routed
  through a `[version]` segment backed by a per-version loader registry in `src/lib/source.ts` —
  cutting a future version is a content-plus-registry-entry change, not a new route. The
  unversioned `/docs/core` and `/docs/alineo` URLs (already indexed in production) now redirect
  to the latest version via a Cloudflare Pages `public/_redirects` file, since `next.config.ts`
  redirects aren't available under this app's static export. A hand-rolled version switcher
  (fumadocs' old `RootToggle` was removed from the public API in fumadocs-ui 16.2) sits in each
  product's sidebar, showing a plain `v0.1` label today and becoming an interactive dropdown the
  moment a second version exists. `workflow`, `agent`, and `examples` are unaffected — this is
  scoped to the two products that are independently published, versioned packages. See
  `plans/versioned-docs.md` for the full design and the "cut a new version" workflow.

### Patch Changes

- 0a583fe: Add a Cookbooks section: a new fumadocs collection (`/docs/cookbooks`) sourced from the real
  `cookbooks/*/README.md` files via `<include>`, wired into the sidebar tab switcher, sitemap,
  llms.txt/llms-full.txt, and OG image generation the same way Examples already is. The standalone
  `/cookbook` marketing page now lists these recipes instead of showing "Coming soon".
- f734b1e: Wire the `/changelog` page to the changeset-generated `CHANGELOG.md` files for `alineo` and
  `alineo-cli` instead of a hand-edited placeholder entry. Renders a single date-sorted timeline
  (dates from the npm registry, since changesets itself records none), badged per package, cut off at
  the drej -> alineo rename boundary and stripped of internal `Updated dependencies` noise. No public
  API change — docs content only.
- 3ed1f67: Fix `/changelog` overflowing horizontally on narrow viewports. `@tailwindcss/typography`'s `.prose` never sets a wrap rule on inline `code`, so long unbroken identifiers in changelog entries (e.g. `ALINEO_OBSERVABILITY`, `CreateSandboxOptions.metadata`) pushed past the viewport edge instead of wrapping. Inline code now uses `break-words` globally, fixing the changelog page and any other docs page with a long inline-code identifier near a line wrap.
- b4fffa0: Fix docs favicon to match the alineo brand, add per-page SEO metadata (title/description/canonical/OG images generated per doc page instead of one sitewide default), fix the sitemap missing /changelog and /use-cases, and add WebSite JSON-LD.
- 4cc2a9e: Add Cookbook, Examples, and FAQ sections plus llms.txt/llms-full.txt to the docs site. Examples is a new fumadocs collection sourced from the real `examples/*/README.md` files via `<include>` (single source of truth, no content duplication); Cookbook surfaces the existing Core SDK patterns pages under a new top-level nav item; llms.txt/llms-full.txt give LLM crawlers a plain-text index and full-text dump of all docs.

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
