---
---

Docs site only, no publishable package changes: blog cover images + a new post.

- **Blog covers** — `content/blog` frontmatter gains `tag` (`Product` / `Engineering`
  / `Docs`), `cover`, and `coverAlt`. `/blog` is now a featured card + a card grid
  (per the approved layout); each card shows its cover image, falling back to the
  generated `/blog-og/<slug>` when unset. `/blog/<slug>` renders the cover as a hero
  and uses it for `BlogPosting.image`.
- **Static-export images** — `next.config.ts` sets `images.unoptimized` (no optimizer
  in a static export); MDX `img` is a plain `<img>` (`remarkImageOptions.useImport:
  false`), so `/blog-assets/*` files are served as-is. `_headers` caches
  `/blog-assets/*` immutably.
- **New post** — "A permission gate for sandboxed agents" (`AgentSpec.permissions`),
  with a cover, an embedded terminal demo (GIF), and a mermaid sequence diagram. A
  `tag: Docs` + cover added to the existing "docs are now built for agents" post.
