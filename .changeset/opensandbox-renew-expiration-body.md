---
"@alineo-labs/opensandbox": patch
---

`ControlClient.renewExpiration(id, expiresAt)` now sends the new expiry. It used to POST an empty
body, which OpenSandbox rejects — its `RenewSandboxExpirationRequest` requires an RFC 3339
`expiresAt` — so the method could never succeed. It takes a `Date` or an ISO string.

Worth knowing when you reach for it: a sandbox created **without** a `timeout` never expires, so
there is nothing to renew. The agent SDK creates its sandboxes that way.
