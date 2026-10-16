---
"alineo": minor
"@alineo-labs/schema": minor
---

Add Claude Code as a second harness, driven through the Claude Agent SDK.

- Set `"harness": "claude-code"` in an agent spec. `harnessVersion` pins the
  `@anthropic-ai/claude-agent-sdk` version. `model` is a Claude model id and the API key goes in
  `env` as `ANTHROPIC_API_KEY`.
- A permission policy gates tool calls: `canUseTool` is parked as a `permission_request`, and
  `agent.resolvePermission()` answers it. Claude's own read-only tools do not ask in `"ask"` mode.
- `steer`, `followUp` and `compact` are not available (the adapter declares them `false`).
  `fork` is: `adapter.forkAt(messageId)`, with the `messageId` of a `message_start`.
- `ClaudeCodeAdapter` and `CLAUDE_CODE_CAPABILITIES` are exported and `@experimental`.
- `HarnessAdapter` gains `forkAt`, present when `capabilities.fork` is `true`.
