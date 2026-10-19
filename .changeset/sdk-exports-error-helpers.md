---
"@alineo-labs/sandbox": patch
---

Export `AlineoError`, `errorCodeOf`, `isAlineoError`, `isRetryable` and the `ErrorCode` type from
`@alineo-labs/sandbox`, so a caller can branch on an error's code without installing
`@alineo-labs/errors` as well. They are the same values, not copies.
