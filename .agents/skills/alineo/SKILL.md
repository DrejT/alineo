---
name: alineo
description: >-
  Use when working with the alineo agent SDK (the `Alineo` class — load/resume/attach/spawn,
  prompt/bash streaming, session control) or the alineo CLI (init/spawn/prompt/fork/steer/agents/
  kill/logs/telemetry), writing or debugging agent specs, working with storage adapters
  (SQLite/Postgres) an agent requires, authoring agent-related examples or integration tests, or
  diagnosing issues with the OpenSandbox server or the alineod swarm daemon `alineo init` now
  also starts. Covers the full local dev workflow: server startup, agent lifecycle, spawning
  child agents, ledger querying, alineod's Docker/registry distribution, and Windows-specific
  gotchas.
metadata:
  version: "2.1"
---

# Alineo Skill Reference

## Product Summary

The bare `alineo` package is the **agent SDK** — it runs [Pi](https://pi.ai) coding agents inside
sandbox containers (spawn, exec, checkpoint, resume under the hood), with a durable SQL audit
ledger. A CLI (`alineo-cli`) wraps common agent operations for local dev, and since `0.1.0` also
starts **alineod**, a separate swarm-orchestration daemon built on top of this same SDK (own
Docker image, own HTTP API) — see [CLI Reference](rules/cli.md#alineod-the-swarm-daemon) for
where it fits and how it differs from everything else in this skill.

> This skill covers the `alineo` **agent SDK**, CLI, and (at a "how it's launched and where it
> fits" level) alineod — not the underlying `@alineo-labs/sandbox` client SDK, and not alineod's
> full HTTP API/swarm semantics in depth (see `apps/alineod/README.md` and `/docs/alineod` for
> that).

---

## Skill Index

This skill is organized into modular files. Depending on what you are doing, read the corresponding file in the `rules/` directory:

- **[Architecture](rules/architecture.md)** — Core concepts: the agent SDK, CLI, storage adapters, and the event ledger.
- **[Agent SDK](rules/agent-sdk.md)** — `Alineo.start/resume/attach/spawn`, agent specs, streaming, and session control.
- **[Storage Adapters](rules/adapters.md)** — SQLite/Postgres adapter setup an agent's `opts.adapter` requires, and known issues.
- **[CLI Reference](rules/cli.md)** — `alineo-cli` commands and config files.
- **[Development & Testing](rules/development.md)** — Unit tests, integration tests, building, changesets, and the verification checklist.
- **[Troubleshooting & Resources](rules/troubleshooting.md)** — Common errors, Windows gotchas, and external links.
