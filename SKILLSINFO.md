# Skills System — Usage & Reference Guide

This document explains how the Alineo Skills System works, how to use every
available command, and how skills are structured for contributors.

---

## What Is a Skill?

A **skill** is a `SKILL.md` markdown file that teaches an AI agent how to use a
specific tool, library, or framework. Instead of the agent having to guess or
search documentation, it reads the skill file and knows exactly what to do.

The file is stored in `.agents/skills/<name>/SKILL.md` inside your project.

---

## Skill File Format

Every `SKILL.md` must begin with a YAML frontmatter block:

```markdown
---
name: my-skill
description: >-
  One or two sentences describing when an agent should activate this skill.
  Be specific — this is what the agent reads to decide whether to load the skill.
metadata:
  version: "1.0"
---

# Your skill content here...
```

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Short lowercase name. Used as the folder name on disk. |
| `description` | ✅ | Tell the agent *when* to use this skill. Be precise. |
| `metadata.version` | ✅ | Semver string, e.g. `"1.0"` |

---

## CLI Commands

All commands are available via the `alineo skills` subcommand.

### `alineo skills add <name-or-url>`

Downloads a skill and saves it into `.agents/skills/`.

```bash
# Add a built-in well-known skill by short name
alineo skills add bun
alineo skills add alineo

# Add a skill from any public URL
alineo skills add https://raw.githubusercontent.com/org/repo/main/.agents/skills/my-skill/SKILL.md

# Add a skill from a local file path
alineo skills add ./path/to/my/SKILL.md
```

**What it does:**
1. Resolves the well-known alias (if provided) to a URL.
2. Downloads the raw `SKILL.md` content.
3. Parses the `name:` from the YAML frontmatter.
4. Computes a SHA-256 hash of the content.
5. Saves it to `.agents/skills/<name>/SKILL.md`.
6. Records the entry in `skills-lock.json`.

---

### `alineo skills list`

Lists all currently installed skills in the project.

```bash
alineo skills list
```

**Example output:**
```
Installed skills:
  - bun (from well-known: bun)
  - alineo (from well-known: alineo)
```

---

### `alineo skills remove <name>`

Deletes a skill from the project and removes it from `skills-lock.json`.

```bash
alineo skills remove bun
```

---

### `alineo skills update <name>`

Re-fetches a skill from its original source and overwrites the local copy.
Useful when the upstream skill has been updated.

```bash
alineo skills update bun
alineo skills update alineo
```

**What it does:**
1. Reads the skill's original `source` from `skills-lock.json`.
2. Re-downloads the `SKILL.md` from that source.
3. Compares the new SHA-256 hash with the stored hash.
4. If different: overwrites the file and updates the lockfile.
5. If the same: prints "Already up to date."

---

### `alineo skills info <name>`

Displays detailed metadata about an installed skill.

```bash
alineo skills info bun
```

**Example output:**
```
Skill: bun
  Source:     bun (well-known)
  Hash:       fd5f1bb4977740f54227793d1a18252a5584a7fd89b33d1311c8044b02b83af3
  Installed:  .agents/skills/bun/SKILL.md
```

---

## `skills-lock.json`

This lockfile at the project root tracks every installed skill. It is committed
to version control so the whole team shares the same set of skills.

```json
{
  "version": 1,
  "skills": {
    "bun": {
      "source": "bun",
      "sourceType": "well-known",
      "computedHash": "fd5f1bb4..."
    },
    "alineo": {
      "source": "alineo",
      "sourceType": "well-known",
      "computedHash": "abc123..."
    }
  }
}
```

| Field | Values | Meaning |
|---|---|---|
| `source` | Any string | The original argument passed to `skills add` |
| `sourceType` | `well-known`, `url`, `local` | How the source was resolved |
| `computedHash` | SHA-256 hex string | Content hash for integrity and change detection |

---

## Well-Known Skills

These short names are built into the CLI and resolve to official skill URLs:

| Short Name | Resolves To |
|---|---|
| `bun` / `bun.sh` | Bun runtime, package manager, test runner |
| `alineo` | Alineo sandbox SDK, CLI, storage adapters |

---

## How the Agent Uses Skills

The agent **automatically** discovers any `SKILL.md` file inside `.agents/skills/`
without you needing to run any command. Skills are loaded progressively — only
the `name` and `description` are read upfront, and the full content is loaded
on demand when the agent decides it's relevant.

**Priority order** (highest wins):
1. Skills in the project's `.agents/skills/` folder
2. Skills declared in `skills.json`
3. Global `~/.gemini/config/skills/`

---

## Contributing a New Skill

1. Create the folder: `.agents/skills/<your-skill-name>/`
2. Write a `SKILL.md` with valid YAML frontmatter (see format above).
3. Keep the content focused — cover:
   - A product summary (what the tool is)
   - Quick-start workflow with code examples
   - Key API reference table
   - Common gotchas / Windows-specific issues
   - A verification checklist
4. Test by asking your AI agent to perform a task that uses the skill.

---

## Skill Quality Rating Criteria

| Criterion | Description |
|---|---|
| **Frontmatter completeness** | Has `name`, `description`, `metadata.version` |
| **Description precision** | Describes exactly *when* to activate the skill |
| **Code examples** | Real, runnable code — not pseudocode |
| **Error coverage** | Common errors and their fixes are documented |
| **Verification checklist** | Steps to confirm the work is correct |
| **Windows compatibility** | Notes for Windows-specific gotchas if applicable |
