---
"@alineo-labs/schema": minor
"alineo": minor
---

`AgentSpec` and the permission-policy types move to `@alineo-labs/schema`.

Both remain re-exported from `alineo`, so every existing import keeps working. What stays in
`alineo` is what actually does something: `validateAgentSpec()`, `normalizePermissions()`,
`evaluatePolicy()` and the safe-command lists.

**alineod stops modelling `AgentSpec` as `z.record(z.string(), z.unknown())`.** It was an
opaque pass-through on the reasoning that the SDK owns validation — true for validation, and
not for the wire contract: `specs/alineod/openapi.json` documented the daemon's most important
request body as "some object". It now carries the real shape, and an invalid spec comes back
from `POST /runs` as a 400 naming the bad field rather than failing later inside
`Alineo.start()`. That is a behaviour change: a spec alineod used to accept and fail on is now
refused up front.

`AgentSpec` is still kept twice — a documented `interface` and a Zod schema — because the
interface's doc comments are what a reader sees on hover and `z.infer<>` would erase them. A
type-level assertion now makes the pair provably identical, failing the build if a field is
added to one and not the other. It has to read the schema's `shape` rather than `z.infer` of
the schema: `AgentSpecSchema` is `.loose()`, and an index signature makes every structural
comparison vacuously true.
