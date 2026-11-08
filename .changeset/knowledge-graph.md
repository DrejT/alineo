---
"@alineo-labs/graph": minor
---

New package: knowledge-graph projections over the event ledger, built on graphology. `buildGraph(envelopes)` folds a ledger (or `graphSink(graph)` keeps one current as an `EventSink`) into one graph with a runtime layer and a security layer. Runtime queries: `subtree`, `ancestry`, `failedSubtree`, `sandboxLineage` (forks and restores), `orphanSandboxes`. Security queries: `credentialHolders`, `blastRadius`, `egressReach`, `pendingPermissions`, `explainPath`. The graph is a rebuildable projection, never a source of truth.
