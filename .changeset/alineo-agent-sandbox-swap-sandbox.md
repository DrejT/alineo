---
"@alineo-labs/sandbox": minor
---

**Breaking:** this package is now published as `@alineo-labs/sandbox` (was `alineo`). The sandbox
client — `import { Alineo } from "alineo"` — moves here as `Sandbox`, per the naming inversion
tracked in [#182](https://github.com/DrejT/alineo/issues/182): the bare `alineo` package name now
belongs to the sandboxed-agent API (see that package's own changeset entry).

```diff
-import { Alineo } from "alineo";
-const client = new Alineo({ baseUrl, adapter });
+import { Sandbox } from "@alineo-labs/sandbox";
+const client = new Sandbox({ baseUrl, adapter });
```

Two supporting types are also renamed, to avoid colliding with `@alineo-labs/core`'s pre-existing
`SandboxError`/`SandboxOptions` (which mean something different — container-state errors and
per-`.sandbox()`-call options, respectively):

```diff
-import { AlineoError, type AlineoOptions } from "alineo";
+import { SandboxClientError, type SandboxClientOptions } from "@alineo-labs/sandbox";
```

Every other exported type is unchanged (`ResumeOptions`, `SandboxOptions`, `SandboxHooks`,
`SandboxDetails`, `SandboxStatus`, ...). `client.sandbox()`'s return type is now `SandboxHandle`
(was `Sandbox`) — see `@alineo-labs/core`'s changeset entry.
