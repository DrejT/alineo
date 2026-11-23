---
"@alineo-labs/workflow": minor
"@alineo-labs/agent-browser": minor
---

Hand a workflow's browser to a person for one step.

- `@alineo-labs/workflow`: `sb.host(name, fn)` runs a step on the host with the live sandbox
  and the `vars` so far, between queued ops. `SandboxLike` now includes `proxy`. `HostStep` and
  `SandboxLike` are exported.
- `@alineo-labs/agent-browser`: `handover(sb, b, { until, timeoutMs, onLive, onEnd })` starts
  the live view, waits until the page reaches a URL, selector, text or JavaScript condition, then stops the
  view. `b.waitForFn(expression)` waits for a JavaScript condition (`wait --fn`).
  `relayBrowserStream(stream, viewer)` relays the live view to a person's tab: it keeps the
  proxy headers on the server and passes only frame/status/url messages and input messages.
  `enableBrowserStream` and `disableBrowserStream` take a `session` option and need only
  `exec` and `proxy` from the sandbox.
