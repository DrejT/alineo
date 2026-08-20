---
"docs": minor
---

Add versioned docs for the Core SDK (`alineo`) and CLI (`alineo-cli`) sections. Content for
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
