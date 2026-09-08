# @alineo-labs/docs-mcp

A stateless [MCP](https://modelcontextprotocol.io) server that exposes the alineo
documentation to MCP clients (Claude Code, Cursor, ChatGPT desktop, opencode, …).

**Endpoint:** `https://docs.alineo.tech/mcp`

## Tools

| Tool                         | Purpose                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `search_docs(query, limit?)` | Rank documentation pages by a query; returns title, URL, description, and a snippet.    |
| `get_doc(path)`              | Fetch one page's full Markdown (accepts a URL, `/docs/...` path, or `collection/slug`). |
| `list_docs()`                | The full page index — title, URL, description for every page.                           |

## How it works

The Worker reads the live site at request time — `/search-index.json` and
`/llms.mdx/*.md` — and caches responses at the edge (1 h). There is no build-time
data step, so it always reflects what's deployed at `docs.alineo.tech`.

This server is **read-only and documentation-only**. It does not run or orchestrate
sandboxes.

## Local development

```bash
bun install
bun run dev        # wrangler dev on :8787
bun run typecheck
```

## Deploy

Automatic on push to `main` touching `apps/docs-mcp/**`
(`.github/workflows/deploy-docs-mcp.yml`, via `wrangler deploy`). The deploy token
(`CLOUDFLARE_API_TOKEN`) needs **Account · Workers Scripts · Edit**.

The public endpoint `docs.alineo.tech/mcp` is a Worker **route**, added once in the
dashboard — **Workers & Pages → alineo-docs-mcp → Settings → Domains & Routes → Add
route** → `docs.alineo.tech/mcp*` (zone `alineo.tech`). Workers routes take
precedence over the Pages site on the same hostname. It's kept out of
`wrangler.toml` so the deploy token doesn't also need **Workers Routes · Edit**.
Until the route exists, the Worker is reachable at its `*.workers.dev` URL.
