---
"alineo": minor
"alineo-mcp": minor
"alineo-cli": patch
---

**BREAKING:** `AgentSpec.cli` → `AgentSpec.harness`, `cliVersion` → `harnessVersion`.

```diff
-{ "name": "my-agent", "cli": "pi", "cliVersion": "1.2.3", "model": "…" }
+{ "name": "my-agent", "harness": "pi", "harnessVersion": "1.2.3", "model": "…" }
```

`cli: "pi"` said the agent-loop driver *is* a CLI. True of Pi, accidental in general — Claude
Code, Codex and opencode are the next drivers, and `cli: "claude-code"` would read as a category
error the day one ships. Renaming now costs one field; renaming after three drivers ship costs a
migration and a docs rewrite.

There is no alias, but a spec that still uses `cli` gets told so by name rather than
"must have a 'harness' field":

```
✖ Agent spec must have a 'harness' field. Supported values: pi

This spec uses 'cli' and 'cliVersion', renamed to 'harness' and 'harnessVersion':
the field names the agent-loop driver, which is not always a CLI.
```

**Your cached snapshots survive.** `computeSetupHash()` deliberately keeps the old key names in
the object it hashes — it is a cache key nobody reads, and changing the spelling would have
invalidated every existing snapshot, turning a field rename into a ~90s rebuild of every agent.

`alineo list` now heads that column `HARNESS`, and `alineo-mcp`'s `SpecSummary.cli` is
`SpecSummary.harness`. The published JSON Schema at `registry.alineo.tech/spec/agent.json`
requires `harness`, so an editor validating an old spec against `$schema` will flag it.

Unchanged: telemetry's own `cliVersion`, which is the version of the alineo CLI itself — a
different field that happens to share a name.
