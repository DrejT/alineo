---
"@alineo-labs/schema": minor
"alineo-mcp": minor
---

alineod can now require authentication and keep tenants apart, so anyone can serve alineo's MCP to their own users.

`@alineo-labs/schema`: the `run.started` event takes an optional `tenantId`, and the wire contract adds `RunSummary` and `ListRunsResponse` for the new `GET /runs`.

`alineo-mcp`: a new `run_list` tool lists your runs, newest first. The client sends `Authorization: Bearer` from `ALINEOD_API_KEY` when it is set, and `AlineodClient` takes `apiKey` or a per-call `authorization` function. With neither set, nothing changes.

`alineo-mcp` can now be served to other people. `alineo-mcp --http` serves streamable HTTP in a remote mode: no `init`, no local files in `spec_add` (an inline `spec`, or a public https `url` that is checked against private addresses, redirects and size), specs kept in a `SpecStore`, and the caller's own `Authorization` header forwarded to alineod. A request with no header is refused unless `--allow-anonymous` is set. There is a new `spec_get` tool. `alineo-mcp/server` exports `buildServer`, `createHttpMcp`, `serveHttp`, `MemorySpecStore` and `fetchPublicJson` for a program that serves the MCP itself.
