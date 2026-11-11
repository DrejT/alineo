---
"@alineo-labs/schema": minor
"alineo-mcp": minor
---

alineod can now require authentication and keep tenants apart, so anyone can serve alineo's MCP to their own users.

`@alineo-labs/schema`: the `run.started` event takes an optional `tenantId`, and the wire contract adds `RunSummary` and `ListRunsResponse` for the new `GET /runs`.

`alineo-mcp`: a new `run_list` tool lists your runs, newest first. The client sends `Authorization: Bearer` from `ALINEOD_API_KEY` when it is set, and `AlineodClient` takes `apiKey` or a per-call `authorization` function. With neither set, nothing changes.
