---
---

Docs site only, no publishable package changes: add per-page "Copy Markdown" and
"Open in ChatGPT / Claude / …" actions to every docs page (the pattern
better-auth.com's docs use).

- **New** `src/app/llms.mdx/[...slug]/route.ts` — a `force-static` Route Handler that
  serves each docs page's processed markdown (reusing `getLLMText`) at
  `/llms.mdx/<collection>/<...slug>.md`. The trailing `.md` is load-bearing: the static
  export writes each handler to a file, and a bare `/llms.mdx/core/adapters` would
  collide with the `adapters/` directory of its child pages — same leaf-path trick
  `docs-og` uses.
- **New** `src/lib/doc-markdown.ts` — the `docCollections` map (path segment → source)
  plus URL helpers, shared by the route and the page actions.
- **New** `src/components/doc-page-actions.tsx` — thin wrapper over fumadocs 16's
  built-in `MarkdownCopyButton` / `ViewOptionsPopover` (Copy Markdown button + an "Open"
  menu: GitHub, View as Markdown, Scira, ChatGPT, Claude, Cursor).
- All six `docs/<collection>/[[...slug]]/page.tsx` render `<DocPageActions>` under the
  title and advertise the markdown URL via `alternates.types["text/markdown"]`.
