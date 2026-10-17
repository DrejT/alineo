---
"alineo": minor
"@alineo-labs/schema": minor
"alineo-cli": patch
"alineo-mcp": patch
---

Let `harness` and `model` in an agent spec carry their own version and provider.

```json
{
  "harness": { "id": "codex", "version": "0.162.1" },
  "model": { "provider": "openai", "id": "gpt-5-codex" }
}
```

- `harness` is an id or `{ id, version }`. `model` is an id or `{ provider, id }`. The string forms
  are unchanged and not deprecated.
- The top-level `harnessVersion` and `provider` still work and are **deprecated**: use
  `harness.version` and `model.provider`. `validateAgentSpec()` logs one warning per spec and field.
- Setting both spellings to different values is an error, not a silent pick.
- `claude-code` runs on `anthropic` models and `codex` on `openai`. A spec that names another
  provider with one of those harnesses is rejected, where it was ignored before. Pi is unchanged.
- `validateAgentSpec()` returns the flat `AgentSpec` the runtime reads. The new `AgentSpecInput`
  is what an author may write, and `normalizeAgentSpec()` converts one to the other.
