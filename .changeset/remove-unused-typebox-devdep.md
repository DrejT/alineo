---
"alineo-cli": patch
---

Remove the unused `typebox` devDependency — leftover from `pi-extension/alineo.ts`'s typed tools
(`alineo_spawn`/`alineo_prompt`/`alineo_agents`/`alineo_kill`), which were already removed in favor
of bash-only CLI usage. No source file in this package imports it. No behavior change.
