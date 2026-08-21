---
"@alineo-labs/core": minor
---

**Breaking:** the `Sandbox` class is renamed to `SandboxHandle`. Part of the naming inversion
tracked in [#182](https://github.com/DrejT/alineo/issues/182): the top-level `alineo` package
becomes the sandboxed-agent API and `@alineo-labs/sandbox` becomes the sandbox-client API, which
frees up `Sandbox` for the client's own class name — this package's per-instance class needed a
new name to avoid colliding with it, and `SandboxHandle` was chosen to match the existing
`ExecHandle`/`InteractiveExecHandle` convention.

```diff
-import type { Sandbox } from "@alineo-labs/core";
+import type { SandboxHandle } from "@alineo-labs/core";
```

Most consumers get this type through `alineo` or `@alineo-labs/sandbox`'s re-export rather than
importing `@alineo-labs/core` directly — see those packages' own changeset entries.
