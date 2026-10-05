# docs

Documentation site for alineo, deployed to [docs.alineo.tech](https://docs.alineo.tech).

Next.js + [Fumadocs](https://fumadocs.dev), content authored as MDX.

## Structure

```
content/docs/
  alineod/     — swarm control daemon (the docs land here)
  agent/       — Agent SDK, the `alineo` package (Pi coding agents in sandboxes)
  cli/         — alineo CLI (`alineo-cli`), spec registry
  core/        — Core SDK, `@alineo-labs/sandbox`: sandboxes, exec, ledger
  workflow/    — Workflow SDK, `@alineo-labs/workflow`: the lazy pipeline builder
  cookbooks/   — task-shaped recipes across products
  playground/  — in-browser runs
content/blog/  — blog posts
src/
  app/            — Next.js App Router routes, layout, sitemap
  components/     — search dialog, playground, cookbook widgets
  lib/source.ts   — Fumadocs content sources, one per collection
```

Each product follows the same four beats — `index.mdx` (what it is, with running code), `quickstart.mdx`,
`concepts/`, `api-reference/` — plus top-level pages for operating it (e.g. `alineod/deployment.mdx`). There is no
`getting-started/` or `guides/` folder.

Each top-level folder under `content/docs/` has its own `meta.json` controlling sidebar order; page routing follows the file path (e.g. `content/docs/cli/registry/schema.mdx` → `/docs/cli/registry/schema`).

## Commands

```bash
bun run dev      # next dev
bun run build    # next build -> static export in out/
bun run start    # next start (serve a build)
bun run lint     # eslint
bun run deploy   # next build + wrangler pages deploy (project: alineo-docs)
```
