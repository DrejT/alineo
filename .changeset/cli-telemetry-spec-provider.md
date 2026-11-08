---
"alineo-cli": patch
---

Telemetry sends the spec's provider again for `start` and `spawn`. It was keyed on the old verbs `spawn` and `fork`, so after the rename `start` sent none and `spawn` read the parent sandbox id as a spec path.
