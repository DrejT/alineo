---
---

Docs site only, no publishable package changes: blog, Mermaid diagrams, a brand
page, a machine-readable search index, and a light-themed OG image redesign.

- **Blog** — new `content/blog` collection with `/blog` (index), `/blog/<slug>`
  (`BlogPosting` JSON-LD, per-post OG image), and `/blog/rss.xml`. Seeded with one
  post. "Blog" added to the nav; "Use Cases" (a noindexed stub) removed from it.
- **Mermaid** — ` ```mermaid ` fences render as diagrams (`remarkMdxMermaid` +
  a lazy-loaded `<Mermaid>` component themed to the docs light palette). The
  Markdown/LLM output restores the raw fence so agents and GitHub still get it.
  Added a first diagram to `core/getting-started/how-it-works`.
- **`/brand`** — the logo, the single brand color, the neutral palette, and
  typography, plus usage principles.
- **`/search-index.json`** — a flat, machine-readable index of every docs page
  (title, description, headings, section text, canonical + Markdown URLs) — a
  companion to `/llms.txt` and `/api/search`. Linked from the AI Resources page and
  the seed blog post.
- **OG images** — `renderOgImage` redesigned to match the docs light theme (white
  field, burgundy edge + eyebrow, dark title) instead of the previous black card.
  Covers `opengraph-image`, `twitter-image`, `docs-og/*`, and the new `blog-og/*`.
- `src/lib/mdx-components.tsx` — the per-collection MDX component maps are now one
  shared object.
