---
"alineo": patch
---

`AgentSnapshotStore` now runs its writes one at a time. Two specs finishing their setup at the same moment used to read the same file and the second write dropped the first record. That showed up when many agents were restored together.
