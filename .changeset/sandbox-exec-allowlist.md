---
---

`apps/sandbox` only, no publishable package changes: `POST /api/sandboxes/:id/exec` is
public and unauthenticated, so restrict it to an exact-match allowlist of the fixed
commands the docs playground's guided workflows actually send
(`apps/sandbox/server/config.ts`'s new `ALLOWED_EXEC_COMMANDS`) — anything else now gets a
403 instead of running. Every playground step already runs a hardcoded command (the
editable snippet/fix/task fields go through `writeFile`/the agent prompt, not this route),
so this closes the arbitrary-shell surface with no change to playground behavior. Verified
the 15-entry allowlist matches every command in `apps/docs/src/lib/playground/workflows.ts`
1:1, programmatically diffed against the source.
