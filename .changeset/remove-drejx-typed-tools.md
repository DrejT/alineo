---
"drejx": patch
---

Remove `pi-extension/drejx.ts`'s typed `drejx_spawn`/`drejx_prompt`/`drejx_agents`/`drejx_kill`
tools. They sat next to `drejx fork` — deliberately never a typed tool, since forking is a
judgment call about task decomposition that belongs in a real shell command — and that
asymmetry measurably steered models toward the wrong primitive (issue #21 Bug B: a run picked
the typed `drejx_spawn` tool over the `drejx fork` shell command the guidance text recommended
for that exact scenario). All five subcommands are bash-only now, guided by the same prose
guidance the extension already injected. The extension itself stays in place, deprecated,
for its remaining `before_agent_start` guidance injection and `ensureDrejxReady()` bootstrap.
