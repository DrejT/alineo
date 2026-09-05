---
---

Docs site only, no publishable package changes: fix the top navbar overlapping the
sidebar and "On this page" TOC on scroll.

Every page is wrapped in `HomeLayout` (navbar: `sticky h-14 top-0 z-40`), and the docs
pages nest `DocsLayout` inside it. `DocsLayout` assumes nothing sits above it on desktop
(`--fd-header-height: 0px`), so its sticky sidebar and TOC anchored at `top: 0` and slid
under the 56px navbar. Set `--fd-banner-height: 3.5rem` — the offset fumadocs feeds into
`--fd-docs-row-1` for exactly this "fixed bar above the layout" case — so the sticky rails
park below the navbar.
