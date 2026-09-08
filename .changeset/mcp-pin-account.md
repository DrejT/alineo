---
---

Docs MCP Worker config only, so the deploy works with a minimal Cloudflare token
(just **Workers Scripts: Edit**): drop the `routes` from `apps/docs-mcp/wrangler.toml`
— the `docs.alineo.tech/mcp` route is added once in the Cloudflare dashboard, so the
token doesn't also need "Workers Routes: Edit". Until then the Worker is on its
`*.workers.dev` URL. `account_id` stays out of the file (it comes from the
`CLOUDFLARE_ACCOUNT_ID` secret).
