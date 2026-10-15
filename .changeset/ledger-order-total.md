---
"@alineo-labs/ledger": patch
---

Make `inLedgerOrder()` a total order. Seq within an aggregate and ts across aggregates is cyclic
when a clock runs backwards inside one aggregate, so the result depended on the runtime's sort.
Each event now takes the highest ts seen so far in its aggregate, and ties break on aggregate,
then seq. Healthy ledgers, whose ts never runs backwards, sort exactly as before.
