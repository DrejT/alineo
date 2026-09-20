---
---

alineod only (private app), no publishable package changes. Two error messages read better: a request body that is the wrong type as a whole no longer says `invalid request body: : Invalid input…` (a dangling `: ` when the failing issue has no field path), and OpenSandbox errors — whose client puts the raw JSON response body in `message` — are unwrapped to a sentence plus its code (`Sandbox sb-1 not found. (DOCKER::SANDBOX_NOT_FOUND)`) wherever alineod records or returns one: an agent's `error` in the ledger and logs (`lost`, `failed`), and the `502`/`500` response bodies.
