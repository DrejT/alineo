---
---

Docs site only, no publishable package changes: turn the Cookbooks section into interactive
walkthroughs.

- Each `content/docs/cookbooks/*.mdx` recipe now opens with a `<CookbookMeta>` badge row
  (difficulty, time, primitives used), walks Setup/What-it-does through `<Steps>`, and has a
  `<CookbookPlayground>` — a terminal-styled, click-to-play simulation of the recipe's actual
  `bun install`/`bun start` commands and the output they produce. It's a scripted replay, not a
  live sandbox, and says so; a "Run it for real →" link always points at the real recipe in the
  repo.
- New `apps/docs/src/components/cookbook/{playground,meta,grid}.tsx` and
  `apps/docs/src/lib/cookbooks-meta.ts` (single source of truth for the listing pages' cards —
  icon, difficulty, time — kept in sync with each recipe's own `<CookbookMeta>`).
- `/cookbook` (marketing) and `/docs/cookbooks` (index) now render the same icon + difficulty +
  time card grid via `<CookbookGrid>`, replacing the plain title/description list.
- `resumable-etl-pipeline` and `credential-scoped-agent` also pick up `<Tabs>`/`<Accordions>`
  for their original-vs-resumed-run and where-to-go-next sections respectively.
