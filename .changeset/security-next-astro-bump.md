---
"docs": patch
---

Bump `next` (apps/docs) to 16.3.1 and `astro` (apps/sandbox, apps/registry) to ^7.2.2 to
resolve 16 open Dependabot alerts (Next.js Server Action/edge runtime issues, Astro dev-toolbar
and content-collection issues). Also drops a stale root `overrides.vite: "7.3.6"` pin — left
over from an Astro 6-era Vite conflict fix — that was forcing an incompatible Vite 7 onto
Astro 7 (which requires Vite ^8) and broke the registry/sandbox builds until removed. No source
changes required; none of these apps use any of the APIs Astro 7 removed or changed. All three
apps are `private: true` and not published, so no version bump is meaningfully consumed here
(apps/sandbox and apps/registry have no `version` field and aren't tracked by changesets at
all; apps/docs is listed only to satisfy the changeset-required check).
