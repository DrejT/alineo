---
"alineo": minor
---

**Breaking:** this package is now published as `alineo` (was `@alineo-labs/agent`). The sandboxed
coding agent — `import { Agent } from "@alineo-labs/agent"` — moves to the top-level `alineo`
package name as `Alineo`, per the naming inversion tracked in
[#182](https://github.com/DrejT/alineo/issues/182): `alineo` is the package most people install
first, so it should hand them the sandboxed agent, not the lower-level sandbox client.

```diff
-import { Agent } from "@alineo-labs/agent";
-const agent = await Agent.load("./agent.json", { adapter });
+import { Alineo } from "alineo";
+const agent = await Alineo.load("./agent.json", { adapter });
```

`Agent.resume()`/`Agent.spawn()`/`Agent.attach()` become `Alineo.resume()`/`Alineo.spawn()`/
`Alineo.attach()`, same signatures. Every other exported type keeps its name (`AgentSpec`,
`AgentEvent`, `AgentStream`, `AgentSnapshotStore`, etc.) — only the class itself is renamed.

The package formerly published as `alineo` (the sandbox client) moves to `@alineo-labs/sandbox` —
see that package's own changeset entry. If you depended on both, both import specifiers change.
