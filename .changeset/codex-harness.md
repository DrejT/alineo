---
"alineo": minor
"@alineo-labs/schema": minor
---

Add Codex as a third harness, driven through `codex app-server`.

- Set `"harness": "codex"` in an agent spec. `harnessVersion` pins `@openai/codex`. `model` is an
  OpenAI model id and the key goes in `env` as `OPENAI_API_KEY`.
- `steer` (`turn/steer`), `compact` (`thread/compact/start`) and `forkAt` (`thread/fork`) work.
  Fork granularity is the turn: every message of a turn has the turn id as its `messageId`.
  `followUp` is not available.
- A permission policy gates command and file-change approvals. Codex asks for each one and the
  bridge answers from the same policy as the other harnesses, parking the ones that need a human
  as a `permission_request`.
- `HarnessAdapter` gains an optional `compact`, present when `capabilities.compact` is `true`.
- `CodexAdapter` and `CODEX_CAPABILITIES` are exported and `@experimental`.
