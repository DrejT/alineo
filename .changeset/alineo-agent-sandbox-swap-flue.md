---
"@alineo-labs/flue": minor
---

**Breaking:** the `peerDependencies` entry `alineo` is renamed to `@alineo-labs/sandbox`, per the
naming inversion in [#182](https://github.com/DrejT/alineo/issues/182) — install
`@alineo-labs/sandbox` instead of `alineo` alongside this package. `alineo(sandbox, opts)`'s
`sandbox` parameter is now typed as `SandboxHandle` from `@alineo-labs/sandbox` (was `Sandbox`
from `alineo`); any object satisfying the same shape still works, this only affects callers who
import the type name explicitly. `alineo(sandbox, opts)`'s own behavior is unchanged.
