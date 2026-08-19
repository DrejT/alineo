---
name: alineo
description: >-
  Use when working with the alineo SDK, running or writing sandbox code, working
  with the alineo CLI (init/spawn/prompt/fork), writing or debugging storage
  adapters (SQLite/Postgres), authoring examples or integration tests, or
  diagnosing issues with the OpenSandbox server. Covers the full local dev
  workflow: server startup, sandbox lifecycle, exec, checkpoint/resume,
  environments, ledger querying, and Windows-specific gotchas.
metadata:
  version: "1.0"
---

# Alineo Skill Reference

## Product Summary

`alineo` is a **sandbox execution substrate** built on [OpenSandbox](https://opensandbox.ai).
It gives you live Linux containers as first-class objects — spawn, exec, checkpoint, resume —
with a durable SQL audit ledger and replay. The TypeScript SDK is the primary interface;
a CLI (`alineo-cli`) wraps common operations for local dev.

---

## Skill Index

This skill is organized into modular files. Depending on what you are doing, read the corresponding file in the `rules/` directory:

- **[Architecture](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/architecture.md)** — Core concepts, clients, adapters, and the event ledger.
- **[Quick Start](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/quick-start.md)** — Server startup and basic usage script.
- **[API Reference](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/api-reference.md)** — Creating clients, sandboxes, executing commands, and checkpoints.
- **[Storage Adapters](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/adapters.md)** — SQLite/Postgres adapter setup and known issues.
- **[CLI Reference](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/cli.md)** — `alineo-cli` commands and config files.
- **[Development & Testing](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/development.md)** — Unit tests, integration tests, building, changesets, and the verification checklist.
- **[Troubleshooting & Resources](file:///d:/Users/Desktop/alineo-npm/alineo/.agents/skills/alineo/rules/troubleshooting.md)** — Common errors, Windows gotchas, and external links.
