---
"alineo-cli": minor
---

Point CLI telemetry at the deployed ingest endpoint (`https://telemetry.alineo.tech`) and flip
the default from off to on, now that the endpoint is actually live. Opt out any time with
`alineo telemetry disable`, `ALINEO_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`. See
`alineo telemetry` in the docs for exactly what's collected.
