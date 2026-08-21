---
"alineo": patch
---

Fix `Alineo`-based scripts hanging after `agent.close()` instead of exiting — see [#189](https://github.com/DrejT/alineo/issues/189).

`sseStream()` (backing `agent.prompt()`/`agent.bash()`) deliberately leaves its connection to the
Pi bridge open when `[DONE]` arrives mid-stream, same reasoning as `ExecClient.parseSSE`
(avoids upsetting the OpenSandbox proxy relaying it — see that method's own comment). Unlike
execd's exec/code streams, though, the bridge's `: ping` heartbeat means there's no bounded
server-side timeout to ever resolve one of these on its own — so with nothing disposing of it,
the dangling connection kept the process alive indefinitely, even after the sandbox itself was
already torn down.

`agent.close()` now force-closes any dangling prompt/bash stream via a new
`PiAdapter.disposeConnections()`, mirroring `ExecClient.disposeConnections()`'s existing pattern.
Uses `AbortController` rather than `reader.cancel()` — the latter was observed to leave the
underlying socket referenced (keeping Bun's event loop alive) on this bridge's specific
long-lived, heartbeat-pinged connections, even though it works fine for execd's own
bounded-lifetime streams.

This fully resolves the hang for a script making exactly one `prompt()`/`bash()` call before
closing. A script making two or more such calls before `close()` can still hang intermittently,
even though every connection's `abort()` fires correctly client-side — not deterministic (fast,
back-to-back calls reproduced it consistently in testing; a real, slower multi-call flow like
`cookbooks/ai-agent-bugfix`'s did not). The timing-dependence points to the same "race at close"
class of bug as [opensandbox-group/OpenSandbox#1277](https://github.com/opensandbox-group/OpenSandbox/issues/1277)
(execd's malformed chunked-SSE termination confusing the OpenSandbox control server's own proxy
relay, which every bridge connection is routed through under `useServerProxy: true`) — not
fixable from this package alone. Tracked in #189.
