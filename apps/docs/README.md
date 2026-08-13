# docs

Documentation site for alineo, deployed to [docs.alineo.tech](https://docs.alineo.tech).

Next.js + [Fumadocs](https://fumadocs.dev), content authored as MDX.

## Structure

```
content/docs/
  core/       — Sandbox primitive, exec, ledger
  workflow/   — @alineo-labs/workflow lazy pipeline builder
  agent/      — @alineo-labs/agent (Pi coding agents in sandboxes)
  alineo/     — alineo CLI, sandbox usage, registry
src/
  app/            — Next.js App Router routes, layout, sitemap
  components/     — package-switcher, search-dialog
  lib/source.ts   — Fumadocs content source config
```

Each top-level folder under `content/docs/` has its own `meta.json` controlling sidebar order; page routing follows the file path (e.g. `content/docs/alineo/registry/schema.mdx` → `/docs/alineo/registry/schema`).

## Commands

```bash
bun run dev      # next dev
bun run build    # next build -> static export in out/
bun run start    # next start (serve a build)
bun run lint     # eslint
bun run deploy   # next build + wrangler pages deploy (project: drej-docs)
```
