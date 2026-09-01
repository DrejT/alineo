---
"alineo": minor
"@alineo-labs/core": minor
---

Add a human-in-the-loop permission gate for sandboxed agents.

`AgentSpec.permissions` — a mode shorthand (`"auto"` (default), `"ask"`, `"readonly"`) or
a full `PermissionPolicy` with ordered per-tool / per-pattern rules (last match wins;
actions `allow` / `ask` / `deny` / `rate_limit` / `classify`, plus `disabledTools` and
`restrictToTools`) — is enforced by a bundled Pi extension (`pi-permission-gate.js`, loaded
via `-e` only when a policy is set).

- Gated tool calls emit a `permission_request` `AgentEvent`; resolve each with
  `agent.resolvePermission(requestId, { kind: "once" | "always" | "reject" })`. A `reject`
  can carry `feedback` that becomes the reason the model reads. `always` / `reject`
  auto-clear other still-pending requests for the same tool.
- `prompt(msg, { onPermission })` auto-resolves each request with the handler's decision —
  no hand-wired `resolvePermission` loop.
- `agent.listPendingPermissions()` reports tool calls currently paused; a reconnecting
  operator (`/permission-stream`) is replayed the outstanding requests and the auto-deny
  timeout is suspended while attached.
- `restrictToTools` / `disabledTools` are applied via Pi's `setActiveTools` at session
  start, so the model never sees a tool it may not use. `"readonly"` restricts the toolset
  to the read tools and `classify`-triages any `bash` call left reachable.
- `classify` does a conservative read-vs-write triage of a `bash` command (split on
  `&&`/`||`/`;`/`|`, checked against a safe-reader list) — read-only → allow, else ask.
- Every request/resolution is written to the ledger (`permission_requested` /
  `permission_resolved`, metadata only — never raw tool args). `Alineo.resume()` closes out
  approvals dropped when the old Pi process ended.
- `abort()` auto-rejects any pending approvals; `steer()` leaves them open.
- Enforcement is in-process (Pi's `tool_call` hook) — it stops a misbehaving model, not a
  process with shell access inside the sandbox actively defeating the gate (that's the
  deferred proxy tier). Ambient user extensions (`settings.json`, `.pi/extensions/`) still
  load and cannot bypass the gate (Pi's first-block-wins hook semantics).
- Default behavior is unchanged: no `permissions` (or `"auto"`) loads no gate.

See `examples/human-in-the-loop` and `plans/human-in-the-loop.md`. Fully durable pauses
across `sb.pause()` / checkpoint (Phase 3c, needs an upstream Pi change) and the
credential-proxy enforcement tier (Phase 4) are tracked as follow-ups in that plan.
