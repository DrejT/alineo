---
---

Repo tooling + docs site only, no publishable package changes: remove docs versioning for `core`/`alineo`.

The versioned-docs setup (`plans/versioned-docs.md`) shipped the machinery — per-version
content trees, a `[version]` route segment, codegen'd `source.config.ts`/`src/lib/source.ts`,
`cut-doc-version.ts` + its `release:version`/CI wiring, `public/_redirects` generation — but
never actually shipped the one user-facing feature it existed for: `VersionSwitcher` has been
commented out of both layouts since it was added, so there was no way to reach `0.1`/`0.2`
from the UI anyway. Reverting to a single unversioned tree per product, matching
`workflow`/`agent`/`examples`.

- `content/docs/{core,alineo}/v0.1`, `v0.2` deleted outright (not archived); `v0.3`'s content
  flattened up to `content/docs/{core,alineo}/` with its internal `/docs/<product>/0.3/...`
  links repointed to the unversioned form.
- `source.config.ts` / `src/lib/source.ts`: back to one `defineDocs()`/`loader()` per product,
  no more `AUTO-GENERATED-VERSIONED-DOCS` codegen block.
- Routes: `src/app/docs/{core,alineo}/[version]/...` → flat `[[...slug]]`, same shape as
  `workflow`/`agent`/`examples`.
- Deleted: `scripts/cut-doc-version.ts`, `scripts/doc-versions.ts`, `scripts/sync-doc-versions.ts`,
  `scripts/sync-redirects.ts`, `src/lib/doc-versions.ts`, `src/components/version-switcher.tsx`.
- `apps/docs/package.json`: dropped `predev`/`prebuild` (they only ran the two sync scripts above).
- Root `package.json`: `release:version` back to plain `bun changeset version`.
- `ci.yml`: removed the `Docs version check` job.
- `public/_redirects`: hand-written now — old versioned/legacy URLs (`/docs/core/0.1`..`0.3`,
  `/docs/core/v0.1`, and the `alineo` equivalents) 301 to the unversioned page instead of
  being generated from the version folder set.
- Fixed a handful of stale cross-links elsewhere pointing at specific old versions
  (`content/docs/agent/*`, `content/docs/workflow/building/sandbox-builder.mdx`,
  `cookbooks/credential-scoped-agent/README.md`) to the unversioned form.
