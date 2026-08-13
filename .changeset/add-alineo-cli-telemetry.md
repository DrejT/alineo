---
"alineo-cli": minor
---

Add anonymous CLI usage telemetry: which subcommand ran, a small per-command allowlist of
boolean flag presence (never values or raw argv), success/failure, timing, and — for
`spawn`/`fork` only — the target spec's own `provider` id. Default-off for this release (no
production endpoint deployed yet — flips on once one is), opt-out via
`alineo telemetry disable`/`status`/`enable` or the `ALINEO_TELEMETRY_DISABLED`/`DO_NOT_TRACK`
env vars either way. Transport is a plain, bounded (500ms timeout) `fetch()` POST to a new,
completely standalone ingest app, `apps/telemetry` — no OpenTelemetry, no dependency on any
other app in this repo, in either direction. Server-side re-validates every event against the
same allowlisted shape (never trusts the client), with a body-size cap and a per-anonymous-ID
rate limit on its one unauthenticated route.
