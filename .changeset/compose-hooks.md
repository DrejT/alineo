---
"@drej/core": minor
---

Add `composeHooks(hooks, opts?)` to merge multiple `SandboxHooks` into one, so more than one
hooks-based adapter (e.g. `otelHooks(tracer)` plus a future billing hook) can attach to the
same sandbox without hand-writing a merged object. Each hook invocation is isolated in its
own try/catch — a throwing hook can't break sibling hooks or the sandbox operation that
triggered them; failures are reported via the optional `onHookError` callback.
