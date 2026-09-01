# human-in-the-loop

A scripted, unattended walkthrough of `AgentSpec.permissions` — the "pause and ask before
this tool runs" gate for sandboxed Pi agents.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time)
export NVIDIA_API_KEY=...
```

## Run

```bash
bun install
bun start
```

## What it shows

**1 — `permissions: "readonly"`** (`agents/readonly-agent.json`)
The gate removes `write` / `edit` / `bash` from the model's toolset at session start (via
Pi's `setActiveTools`), so the agent can read a repo but _cannot_ change it — it reports
that it has no way to create the file.

**2 — the full gate** (`agents/hitl-agent.json`)

```jsonc
"permissions": {
  "default": "ask",
  "rules": [
    { "tool": "read", "action": "allow" },
    { "tool": "grep", "action": "allow" },
    { "tool": "find", "action": "allow" },
    { "tool": "ls",   "action": "allow" },
    { "tool": "bash", "action": "classify" },              // read-only bash runs free
    { "tool": "bash", "pattern": "*rm -rf*", "action": "deny" }  // hard-blocked, no prompt
  ]
}
```

The script prompts the agent through a fixed sequence and, via `prompt(msg, { onPermission })`:

| step                                 | what the gate does                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `ls -la`, `cat … && uname -sr`       | `classify` → read-only → **runs, no prompt**                                      |
| write `hello.py`, `python3 hello.py` | `ask` → handler **allows once**                                                   |
| `pip install requests`               | `ask` → handler **denies with feedback**; the model reads the reason and moves on |
| `rm -rf /tmp/demo-scratch`           | `deny` rule → **blocked outright**, nobody is asked                               |

Then it prints `agent.listPendingPermissions()` (empty — all resolved) and reads the
**ledger audit trail** back from the storage adapter: a `permission_requested` /
`permission_resolved` pair for every gated call.

## Notes

- Omitting `permissions` (or `"auto"`) keeps the pre-approval behavior — nothing pauses.
  `"ask"` pauses before every tool call.
- `classify` is best-effort: it splits a command on `&&` / `;` / `|` and allows it only if
  every part is a recognised pure reader (`ls`, `cat`, `grep`, `git status`, …). Anything
  else → `ask`.
- Enforcement runs inside the Pi process (`tool_call` hook) — it stops a misbehaving model,
  not a process with shell access inside the sandbox actively working around it.
- Every request/resolution is on the ledger, so `alineo logs <session>` (or any adapter
  read) is a full record of what was gated and how it was decided.
