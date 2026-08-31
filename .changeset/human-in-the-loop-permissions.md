---
"alineo": minor
---

Add a human-in-the-loop permission gate for sandboxed agents.

`AgentSpec.permissions` — a mode shorthand (`"auto"` (default), `"ask"`, `"readonly"`) or
a full `PermissionPolicy` with ordered per-tool / per-pattern rules (last match wins;
actions `allow` / `ask` / `deny` / `rate_limit`, plus `disabledTools`) — is enforced by a
bundled Pi extension (`pi-permission-gate.js`, loaded via `-e` only when a policy is set).

- Gated tool calls emit a `permission_request` `AgentEvent`; resolve each with
  `agent.resolvePermission(requestId, { kind: "once" | "always" | "reject" })`. A `reject`
  can carry `feedback` that becomes the reason the model reads. `always` / `reject`
  auto-clear other still-pending requests for the same tool.
- `abort()` auto-rejects any pending approvals; `steer()` leaves them open.
- Denied calls surface to the model as a normal `isError` tool result, so it adjusts
  rather than retrying blindly.
- Enforcement is in-process (Pi's `tool_call` hook) — it stops a misbehaving model, not a
  compromised sandbox. Ambient user extensions (`settings.json`, `.pi/extensions/`) still
  load and cannot bypass the gate (Pi's first-block-wins hook semantics).
- Default behavior is unchanged: no `permissions` (or `"auto"`) loads no gate.

See `examples/human-in-the-loop` and `plans/human-in-the-loop.md`. Durable pauses across
resume (Phase 3), the credential-proxy enforcement tier (Phase 4), and the RLM-extension
move are tracked as follow-ups in that plan.
