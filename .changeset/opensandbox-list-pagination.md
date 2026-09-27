---
"@alineo-labs/opensandbox": patch
"alineo-cli": patch
---

`ControlClient.listSandboxes()` now returns every sandbox, not just the first 20. OpenSandbox
paginates with `page`/`pageSize` and ignores the `limit`/`offset` this client was sending, so every
listing stopped at the server's default page. The visible symptom: `alineo agents` cross-checks the
ledger against the live list, so with more than 20 sandboxes running it reported the rest as
gone. `limit` and `offset` still work — they are applied after every page is fetched.
