---
---

Docs site only, no publishable package changes: SEO / AEO / GEO pass, benchmarked
against the better-auth docs.

- **`public/_headers`** — Next's metadata image routes (`opengraph-image`,
  `twitter-image`, `docs-og/*`) are emitted as extension-less files that Cloudflare
  served as `application/octet-stream`, so every link-preview crawler (Slack, X,
  LinkedIn, Discord, iMessage) refused to render them. Force `image/png`. Also serve
  `llms.txt` / `llms-full.txt` as `text/markdown`.
- **Real sitemap dates** — `source.config.ts` now runs fumadocs' `last-modified`
  plugin (git commit date per file); `sitemap.ts` uses it for `<lastmod>` instead of
  the build timestamp, and dates the changelog from its newest release. The docs
  deploy workflow checks out with `fetch-depth: 0` so the history is present.
- **`/llms.txt` rewrite** — adds a "how to use this file" preamble (fetch the `.md`
  form, cite the canonical URL without `.md`, pointer to `llms-full.txt`) and points
  every entry at its `/llms.mdx/*.md` URL instead of the HTML page. Sections are `##`,
  not a second `#`.
- **New `/docs/core/ai-resources`** — documents llms.txt / llms-full.txt / per-page
  Markdown / agent skills so the GEO surface is discoverable.
- **Structured data** — `FAQPage` on `/faq`; per-page `TechArticle` + `BreadcrumbList`
  (`DocStructuredData`) across all six doc collections, with `dateModified` from the
  git date. The site-wide `WebSite` object is unchanged.
- **`/use-cases`** — placeholder page is now `noindex` and dropped from the sitemap
  until it has content.
