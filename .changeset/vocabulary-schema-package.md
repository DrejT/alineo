---
"@alineo-labs/schema": minor
---

New package: `@alineo-labs/schema`, holding the `SUBJECTS` and `VERBS` lists that every alineo
surface derives its names from, plus `isSubject`, `isVerb` and `parseName`.

Vocabulary only — no event definitions and no wire types yet. The checks that enforce the lists
land with the surfaces they police (CLI commands and help strings, MCP tools, HTTP routes, event
types), so a surface cannot ship a name without also shipping the thing that would reject it.
