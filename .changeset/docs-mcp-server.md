---
---

New `apps/docs-mcp` — a Model Context Protocol server for the alineo documentation,
served at `docs.alineo.tech/mcp`. No publishable package changes.

- A stateless Cloudflare Worker (`@modelcontextprotocol/server`) exposing three
  read-only tools: `search_docs`, `get_doc`, `list_docs`.
- Data comes from the live docs at request time (`/search-index.json`,
  `/llms.mdx/*.md`), cached at the edge — no build-time bundling, always current.
- `deploy-docs-mcp.yml` deploys it on push to `main` touching `apps/docs-mcp/**`;
  `ci.yml` typechecks it on every PR.
- Docs: `/docs/core/ai-resources` gains an MCP section with client setup snippets
  (Claude Code, Cursor deeplink, opencode) and a note that this is separate from
  the SDK/CLI that actually runs sandboxes.
- `src/lib/mdx-components.tsx` now also carries `Tabs`/`Accordion` (the cookbooks
  route dropped its local copies).
