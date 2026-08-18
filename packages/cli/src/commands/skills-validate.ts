import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { readConfig } from "../config.js";

/**
 * Validates one or all installed skills, printing advisory warnings.
 *
 * Usage: `alineo skills validate [name]`
 */
export async function validateSkills(name: string | undefined, log: (msg: string) => void): Promise<void> {
  const config = await readConfig();
  const skillsDir = config.skillsDir;

  if (!existsSync(skillsDir)) {
    log("No skills installed (skills directory not found).");
    return;
  }

  let skillsToValidate: string[] = [];
  if (name) {
    const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const skillPath = join(skillsDir, safeName);
    if (!existsSync(skillPath)) {
      throw new Error(`Skill not installed: ${name}`);
    }
    skillsToValidate.push(safeName);
  } else {
    // List all directories in skillsDir
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skillsToValidate.push(entry.name);
      }
    }
  }

  if (skillsToValidate.length === 0) {
    log("No skills installed.");
    return;
  }

  let totalWarnings = 0;

  for (const skill of skillsToValidate) {
    log(`Validating ${skill}...`);
    const skillDir = join(skillsDir, skill);
    const skillMd = join(skillDir, "SKILL.md");

    if (!existsSync(skillMd)) {
      log(`  \u26A0 SKILL.md missing in ${skill}`);
      totalWarnings++;
      continue;
    }

    const content = await Bun.file(skillMd).text();
    let warnings = 0;

    // 1. Frontmatter presence
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    if (!nameMatch) {
      log(`  \u26A0 Frontmatter is missing 'name:'`);
      warnings++;
    }

    const descMatch = content.match(/^description:[\s\S]*?(?:^metadata:|^---)/m);
    if (!descMatch) {
      log(`  \u26A0 Frontmatter is missing 'description:'`);
      warnings++;
    } else {
      // 2. Description "when" check
      const descText = descMatch[0].toLowerCase();
      if (!descText.includes("when ") && !descText.includes("use if")) {
        log(`  \u26A0 'description' lacks a trigger phrase (e.g., 'use when')`);
        warnings++;
      }
    }

    // 3. Body size
    const lines = content.split("\n");
    if (lines.length > 500) {
      log(`  \u26A0 SKILL.md is ${lines.length} lines (recommended \u2264 500 lines). Consider moving content to a references/ subdirectory.`);
      warnings++;
    }

    // 4. Relative links check
    // Simple regex for standard markdown links `[text](path)` avoiding `http` and `#` links
    const linkRegex = /\[[^\]]+\]\((?!http|#)([^)]+)\)/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(content)) !== null) {
      let relPath = linkMatch[1];
      // strip query params or hashes if present
      relPath = relPath.split("?")[0].split("#")[0];
      
      const absPath = join(skillDir, relPath);
      if (!existsSync(absPath)) {
        log(`  \u26A0 Broken link: '${relPath}' does not exist in the skill bundle.`);
        warnings++;
      }
    }

    if (warnings === 0) {
      log(`  \u2713 OK`);
    }
    totalWarnings += warnings;
  }

  if (totalWarnings > 0) {
    log(`\nValidation finished with ${totalWarnings} warning(s).`);
  } else {
    log(`\nAll checks passed!`);
  }
}
