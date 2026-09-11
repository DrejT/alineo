---
---

Docs site + sandbox API only, no publishable package changes: a live `/docs/playground`
section where readers run real alineo workflows from the browser — live OpenSandbox
containers, real file writes, real streamed command output, real teardown.

- **New** five guided workflows (`run-untrusted-code`, `ci-test-runner`,
  `checkpoint-and-resume`, `fork-a-sandbox`, `agent-bugfix`), each composing SDK primitives
  into one task, plus a connection panel for switching between the hosted endpoint and a
  local `bunx alineo-cli init` server.
- `apps/sandbox`: `POST /api/sandboxes/:id/exec` (one-shot streamed command),
  `POST /api/sandboxes/:id/fork`, CORS now reflects any allowlisted `Origin` instead of a
  single fixed one, and file/exec routes resolve an agent's sandbox by id too.
