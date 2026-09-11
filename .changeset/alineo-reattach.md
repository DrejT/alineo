---
"alineo": minor
---

New `Alineo.reattach(sandboxId, opts)` — reconnects to a previously-created agent WITHOUT
restarting its bridge, unlike `Alineo.resume()`. `sb.proxy()` is a pure URL lookup against the
sandbox's control plane, so as long as the bridge process inside the sandbox is still running
(the caller's own host process is what exited/restarted, not the sandbox), `reattach()` rebinds
to it with zero side effects: no killed process, no dropped in-flight turn, no reset Pi
conversation state. Fails fast (5s) if the bridge doesn't answer, so callers who aren't sure
which case they're in can try `reattach()` first and fall back to `resume()`:

```ts
let agent: Alineo;
try {
  agent = await Alineo.reattach(savedSandboxId, { adapter });
} catch {
  agent = await Alineo.resume(savedSandboxId, { adapter }); // bridge really is gone
}
```

Motivated by a control-plane daemon (`apps/alineod`, prototype) restarting and needing to
reconnect to every live agent without dropping their in-flight turns.
