---
"alineo": patch
"@alineo-labs/core": patch
---

A permission request still pending when a session resumes (its parked tool call died with the
previous Pi process, and can't be recovered) is now recorded with `decision: { kind: "dropped" }`
instead of `decision: { kind: "reject" }`. The old value claimed a human rejected the request;
none did — nobody could, since the call it was about no longer exists. `"dropped"` says what
actually happened. If anything reads `decision.kind` from `permission.resolved` ledger entries
looking specifically for a human rejection, it should no longer match this case.
