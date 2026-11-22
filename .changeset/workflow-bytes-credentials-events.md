---
"@alineo-labs/workflow": minor
---

Add `readFileBytes`/`writeFileBytes`, `setCredential`, `patchEgress`/`deleteEgress`, per-command output capture (`exec(cmd, { as, parse })`), and step events (`workflow(client, { onEvent })`). Events never carry command text, file contents or credential values.
