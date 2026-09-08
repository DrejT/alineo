---
---

Docs MCP Worker config only: pin `account_id` in `apps/docs-mcp/wrangler.toml` so
the deploy token doesn't need "Account Settings: Read" (and the deploy fails with a
clearer error if the real problem is missing Workers permissions).
