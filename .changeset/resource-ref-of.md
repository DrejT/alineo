---
"alineo": patch
---

Resolve an agent's memory identity through `resourceRefOf()` from `@alineo-labs/schema` instead of
five inline copies of `spec.resourceId ?? spec.name` (the `Alineo` constructor, a spawned child's
frozen `resourceId`, and the ledger threading in `load`/`resume`/`attach`/`spawn`). No behaviour
change; it exists so alineod, which resolves a scope from a persisted spec with no live `Alineo` to
ask, applies the same rule rather than its own reading of it.
