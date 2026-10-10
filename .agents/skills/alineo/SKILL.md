---
name: alineo
description: >-
  Use when working with the alineo agent SDK (the `Alineo` class — start/resume/reattach/attach/
  spawn, prompt/bash streaming, session control, permissions, supervision, turn checkpoints) or
  the alineo CLI (init/add/list/remove/start/prompt/spawn/steer/agents/stop/logs/telemetry),
  writing or debugging agent specs, working with storage adapters (SQLite/Postgres) an agent
  requires, authoring agent-related examples or integration tests, or diagnosing issues with the
  OpenSandbox server or the alineod swarm daemon `alineo init` also starts (runs, fan-out/gather,
  failure policy, crash recovery, memory, the alineo-mcp server). Covers the full local dev
  workflow: server startup, agent lifecycle, spawning child agents, ledger querying, alineod's
  Docker/registry distribution, and Windows-specific gotchas.
metadata:
  version: "2.2"
---

# Alineo Skill Reference

## Product Summary

The bare `alineo` package is the **agent SDK** — it runs [Pi](https://pi.ai) coding agents inside
sandbox containers (spawn, exec, checkpoint, resume under the hood), with a durable SQL audit
ledger. A CLI (`alineo-cli`) wraps common agent operations for local dev, and since `0.1.0` also
starts **alineod**, a separate swarm-orchestration daemon built on top of this same SDK (own
Docker image, own HTTP API, own MCP server `alineo-mcp`) — see
[alineod](rules/alineod.md) for what it does and how it differs from everything else in this
skill.

> This skill covers the `alineo` **agent SDK**, CLI, and alineod at a "what it does, the
> contract it keeps, and where to look" level — not the underlying `@alineo-labs/sandbox` client
> SDK, and not alineod's full HTTP API in depth (see `apps/alineod/README.md` and `/docs/alineod`
> for that).
>
> **Docs are the source of truth, this skill is the index.** If a rule file here and
> `packages/*/src` disagree, the source wins — fix the skill. Check names against
> `packages/schema/src/agent-spec.ts` (spec fields) and `packages/cli/src/commands/registry.ts`
> (CLI verbs) before quoting them.

---

## Skill Index

This skill is organized into modular files. Depending on what you are doing, read the corresponding file in the `rules/` directory:

- **[Architecture](rules/architecture.md)** — Core concepts: the agent SDK, CLI, storage adapters, the event ledger, and its vocabulary.
- **[Agent SDK](rules/agent-sdk.md)** — `Alineo.start/resume/reattach/attach/spawn`, agent specs, streaming, session control, permissions and turn checkpoints.
- **[alineod](rules/alineod.md)** — the swarm daemon: runs, spawn budgets, fan-out/gather, failure policy, crash recovery, memory, the durability contract, `alineo-mcp`.
- **[Storage Adapters](rules/adapters.md)** — SQLite/Postgres adapter setup an agent's `opts.adapter` requires, and known issues.
- **[CLI Reference](rules/cli.md)** — `alineo-cli` commands and config files.
- **[Development & Testing](rules/development.md)** — Unit tests, integration tests, building, changesets, and the verification checklist.
- **[Troubleshooting & Resources](rules/troubleshooting.md)** — Common errors, Windows gotchas, and external links.
