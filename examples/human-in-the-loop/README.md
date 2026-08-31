# human-in-the-loop

A Pi agent whose tool calls pause for operator approval, driven by `AgentSpec.permissions`
and resolved with `agent.resolvePermission()`.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
export NVIDIA_API_KEY=...
```

## Run

```bash
bun install
bun start
```

## What it does

`agents/hitl-agent.json` declares a permission policy:

```jsonc
"permissions": {
  "default": "ask",                                       // pause before anything else
  "rules": [
    { "tool": "read",  "action": "allow" },               // reads run freely
    { "tool": "grep",  "action": "allow" },
    { "tool": "find",  "action": "allow" },
    { "tool": "ls",    "action": "allow" },
    { "tool": "bash", "pattern": "*rm -rf*", "action": "deny" }  // hard-blocked
  ]
}
```

`index.ts` prompts the agent to write and run a script, then attempt an `rm -rf`. Each
gated call arrives as a `permission_request` event; the script asks you in the terminal
whether to allow it (once / always), deny it, or deny with feedback the model then reads.
The `rm -rf` never even prompts — the policy denies it outright.

## Notes

- `permissions: "auto"` (or omitting the field) keeps the pre-approval behavior — nothing
  pauses. `"ask"` pauses before every tool call; `"readonly"` auto-allows reads and pauses
  on writes/exec.
- Tier-1 enforcement runs inside the Pi process (the `tool_call` hook) — it stops a
  misbehaving model, not a compromised sandbox. Network calls go through `bash`, so they're
  gated by `bash` rules, best-effort.
