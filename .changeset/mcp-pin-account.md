---
---

Docs MCP Worker config only, so the deploy works with a minimal Cloudflare token
(just **Workers Scripts: Edit**):

- Pin `account_id` in `apps/docs-mcp/wrangler.toml` (no "Account Settings: Read"
  needed).
- Move the `docs.alineo.tech/mcp` route out of `wrangler.toml` — it's added once in
  the Cloudflare dashboard, so the token doesn't also need "Workers Routes: Edit".
  Until then the Worker is on its `*.workers.dev` URL.
