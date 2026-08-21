---
"alineo": minor
---

`validateAgentSpec()` is now backed by a real schema (Zod) instead of a handful of hand-rolled
`if`/`throw` checks — see [#185](https://github.com/DrejT/alineo/issues/185).

- **Every field is now validated**, not just `name`/`cli`/`spawnDepth`/`maxAgents` — `resources`,
  `env`, `setup`, `packages`, and the rest were previously passed through with zero runtime
  checking (`item as unknown as AgentSpec`). A malformed `resources.cpu` or a non-string `env`
  value now fails fast at `validateAgentSpec()` instead of surfacing later, mid-`loadAgent()`,
  as a much less legible error.
- **Every problem is reported in one throw, not just the first.** A spec with three unrelated
  issues used to require three fix-and-retry rounds; it now reports all three at once.
- **New export: `AgentSpecValidationError`** (thrown in place of a bare `Error`) — carries a
  pre-formatted, human-readable `.message` plus a structured `.issues: { path, message, code }[]`
  array for callers that want to handle failures programmatically (e.g. highlight the offending
  field in a UI) instead of parsing the message string.

Unknown top-level fields on a spec are still passed through untouched (not stripped, not
rejected) — same forward-compatible behavior as before, now explicit via `.loose()` rather than
an implicit side effect of the old type cast.

```ts
import { Alineo, AgentSpecValidationError } from "alineo";

try {
  const spec = await Bun.file("./agent.json").json();
  const agent = await Alineo.load(spec, { adapter });
} catch (e) {
  if (e instanceof AgentSpecValidationError) {
    for (const issue of e.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
  }
  throw e;
}
```
