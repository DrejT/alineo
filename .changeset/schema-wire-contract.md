---
"@alineo-labs/schema": minor
"alineo-mcp": patch
---

alineod's wire contract and `ProjectConfig` move to `@alineo-labs/schema`.

The wire contract gets its own entry point, `@alineo-labs/schema/alineod` — its `AgentSpec`
would collide with the root's, and a consumer that only wants the vocabulary has no business
importing a daemon's request bodies.

**`alineo-mcp` deletes eleven hand-mirrored interfaces.** They were documented as deliberate —
"typed against the wire contract, not against alineod's internal Zod schemas" — which was a
fair objection while those schemas were an app's internals and stops being one now the contract
is published. The boundary still holds: mcp talks to alineod over HTTP like any other client,
and the two request bodies keep `spec: Record<string, unknown>`, because an MCP tool receives
arbitrary JSON from a model and typing it as an `AgentSpec` would claim a guarantee that side
of the wire cannot make.

`ProjectConfig` (the shape of `alineo.config.json`) is now published, so someone writing that
file by hand can get the type from the same place the tooling does. `@alineo-labs/config-shared`
re-exports it and keeps the mechanism — discovery, precedence, the env overlay.

Not done: `apps/telemetry` sharing `CliTelemetryEvent`. It has no dependencies at all and is
deployed by hand onto a VPS, so a workspace dependency would make a standalone service need the
monorepo built to start — a worse trade than thirteen fields written twice.
