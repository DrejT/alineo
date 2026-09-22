---
"alineo-cli": minor
---

**BREAKING:** the three session-lifecycle verbs are renamed so that one word means one thing
across the CLI, the SDK and the MCP tools.

| Before | Now |
|---|---|
| `alineo spawn <spec>` | `alineo start <spec>` |
| `alineo fork <name> <child-spec>` | `alineo spawn <parent> <child-spec>` |
| `alineo kill <sandbox-id>` | `alineo stop <sandbox-id>` |

`spawn` used to mean the opposite of what `Alineo.spawn()` means: the CLI created a **root**
agent, the SDK a **child**. Anyone who learned one and moved to the other was actively misled.
It now means "child" on both.

**There are deliberately no aliases.** `spawn` did not disappear — it changed meaning, so an
alias would silently do the wrong thing with the right-looking command. `alineo spawn ./spec.json`
now fails on its arguments instead, which is the outcome you want: its first argument is a
parent session name. Use `alineo start ./spec.json`.

Also updated so a running agent is told the truth: the Pi extension's injected guidance, the
alineod operator-steer message, the TUI (`s` stops a session; `k` still works), and every help,
error and doc string that quoted a verb. `scripts/check-vocabulary.ts` now fails CI on a command
name that is not in `@alineo-labs/schema`'s `VERBS`, and on any text quoting a command that does
not exist — the check that would have caught `alineo ps`, a command documented in the source for
months that never existed.
