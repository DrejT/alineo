import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { readConfig } from "../config.js";

/**
 * Scaffolds a new skill directory with a starter SKILL.md.
 *
 * Usage: `alineo skills create <name>`
 */
export async function createSkill(name: string, log: (msg: string) => void): Promise<void> {
  if (!name) throw new Error("Usage: alineo skills create <name>");

  const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  const config = await readConfig();
  const destDir = join(config.skillsDir, safeName);

  if (existsSync(destDir)) {
    throw new Error(
      `Skill directory already exists: ${destDir}\n` +
      `Remove it first with: alineo skills remove ${safeName}`,
    );
  }

  await mkdir(destDir, { recursive: true });

  const template = `---
name: ${safeName}
description: >-
  TODO: Describe when an agent should activate this skill. Be specific —
  use phrases like "Use when working with …" or "Use when the user asks
  about …". This is the primary trigger the agent reads to decide whether
  to load the skill.
metadata:
  version: "1.0"
---

# ${name}

<!-- Tip: Keep SKILL.md under ~500 lines. Move large reference material
     into a references/ subdirectory and link to it from here. -->

## When to Use

<!-- Describe the exact situations where this skill should be activated. -->

## Quick Start

<!-- Provide a minimal, runnable example the agent can follow immediately. -->

\`\`\`ts
// TODO: add a quick-start code example
\`\`\`

## Key API Reference

<!-- Document the most important APIs, commands, or patterns. -->

| API / Command | Description |
|---|---|
| \`TODO\` | TODO |

## Common Gotchas

<!-- List known footguns, platform-specific issues, or surprising behaviors. -->

| Symptom | Cause | Fix |
|---|---|---|
| TODO | TODO | TODO |

## Verification Checklist

<!-- Steps the agent should follow to confirm its work is correct. -->

- [ ] TODO: add verification steps
`;

  const destFile = join(destDir, "SKILL.md");
  await Bun.write(destFile, template);

  log(`Created skill scaffold at ${destFile}`);
  log(`Next steps:`);
  log(`  1. Edit ${destFile} — fill in the TODO sections`);
  log(`  2. Run: alineo skills validate ${safeName}`);
}
