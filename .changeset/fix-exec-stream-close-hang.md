---
"@drej/opensandbox": patch
"@drej/core": patch
---

Fix `Sandbox.close()` (and `pause()`) not disposing of exec-stream connections left
deliberately open by `parseSSE`'s early-return optimization (see its comment, and
opensandbox-group/OpenSandbox#1277 — execd's `/command` handler doesn't terminate its
chunked response until a fixed post-completion sleep elapses). Without an explicit
teardown, one of these dangling connections could still be ESTABLISHED by the time a
script called `close()`, keeping the host process's event loop alive indefinitely
instead of exiting. `ExecClient` now tracks these readers and force-cancels them via a
new `disposeConnections()` method, called from `Sandbox.close()`/`pause()` once the
sandbox is being torn down anyway and nobody cares if the (already broken) upstream
proxy relay errors out.
