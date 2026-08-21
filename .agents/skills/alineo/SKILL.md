---
name: alineo
description: >-
  Use when working with the alineo agent SDK (the `Alineo` class — load/resume/attach/spawn,
  prompt/bash streaming, session control) or the alineo CLI (init/spawn/prompt/fork/agents/kill/logs),
  writing or debugging agent specs, working with storage adapters (SQLite/Postgres) an agent
  requires, authoring agent-related examples or integration tests, or diagnosing issues with the
  OpenSandbox server. Covers the full local dev workflow: server startup, agent lifecycle,
  spawning child agents, ledger querying, and Windows-specific gotchas.
metadata:
  version: "2.0"
---

# Alineo Skill Reference

## Product Summary

The bare `alineo` package is the **agent SDK** — it runs [Pi](https://pi.ai) coding agents inside
sandbox containers (spawn, exec, checkpoint, resume under the hood), with a durable SQL audit
ledger. A CLI (`alineo-cli`) wraps common agent operations for local dev.

> This skill covers the `alineo` **agent SDK** and CLI only, not the underlying
> `@alineo-labs/sandbox` client SDK.

---

## Skill Index

This skill is organized into modular files. Depending on what you are doing, read the corresponding file in the `rules/` directory:

- **[Architecture](rules/architecture.md)** — Core concepts: the agent SDK, CLI, storage adapters, and the event ledger.
- **[Agent SDK](rules/agent-sdk.md)** — `Alineo.load/resume/attach/spawn`, agent specs, streaming, and session control.
- **[Storage Adapters](rules/adapters.md)** — SQLite/Postgres adapter setup an agent's `opts.adapter` requires, and known issues.
- **[CLI Reference](rules/cli.md)** — `alineo-cli` commands and config files.
- **[Development & Testing](rules/development.md)** — Unit tests, integration tests, building, changesets, and the verification checklist.
- **[Troubleshooting & Resources](rules/troubleshooting.md)** — Common errors, Windows gotchas, and external links.
