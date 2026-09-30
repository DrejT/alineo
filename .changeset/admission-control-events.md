---
"@alineo-labs/schema": minor
---

Three new alineod control-plane events: `agent.admission_queued`, `agent.admission_granted`,
`agent.admission_timeout`. Backs admission control (backpressure on provisioning): a spawn held
for a free provisioning slot is now visible in the ledger, including when it fails loudly instead
of hanging silently.
