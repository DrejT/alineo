---
---

Docs site only, no publishable package changes: a new blog post, "Keeping secrets out of
agent sandboxes" — the prompt-injection risk of giving an agent credentials directly, then
credential injection (`sb.credentials.set()`) and the surrounding security layers (network
policy, permission gate, egress approval hold, audit ledger). Cover + a terminal demo GIF
recorded against a live sandbox + a `flowchart` of an outbound request through the layers.
