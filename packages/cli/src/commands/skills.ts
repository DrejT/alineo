import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { readConfig } from "../config.js";
import type { CliCommand } from "./types.js";

const WELL_KNOWN: Record<string, string> = {
  "bun": "https://raw.githubusercontent.com/DrejT/alineo/skills/.agents/skills/bun/SKILL.md",
  "bun.sh": "https://raw.githubusercontent.com/DrejT/alineo/skills/.agents/skills/bun/SKILL.md",
  "alineo": "https://raw.githubusercontent.com/DrejT/alineo/skills/.agents/skills/alineo/SKILL.md",
};

interface SkillLockEntry {
  source: string;
  sourceType: "well-known" | "url" | "local";
  computedHash: string;
}

interface SkillsLock {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

async function getSkillsLock(cwd: string): Promise<SkillsLock> {
  const lockPath = join(cwd, "skills-lock.json");
  const lockFile = Bun.file(lockPath);
  if (await lockFile.exists()) {
    try {
      return await lockFile.json();
    } catch {
      // Return default if invalid
    }
  }
  return { version: 1, skills: {} };
}

async function saveSkillsLock(cwd: string, lock: SkillsLock): Promise<void> {
  const lockPath = join(cwd, "skills-lock.json");
  await Bun.write(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

async function addSkill(urlOrName: string, log: (msg: string) => void) {
  if (!urlOrName) throw new Error("Usage: alineo skills add <url-or-name>");
  
  const config = await readConfig();
  const skillsDir = config.skillsDir;
  if (!existsSync(skillsDir)) await mkdir(skillsDir, { recursive: true });

  let sourceUrl = urlOrName;
  let sourceType: SkillLockEntry["sourceType"] = "url";
  
  if (WELL_KNOWN[urlOrName]) {
    sourceUrl = WELL_KNOWN[urlOrName];
    sourceType = "well-known";
  } else if (!urlOrName.startsWith("http://") && !urlOrName.startsWith("https://")) {
    sourceType = "local";
  }

  let content = "";
  if (sourceType === "local") {
    const file = Bun.file(sourceUrl);
    if (!(await file.exists())) throw new Error(`Local file not found: ${sourceUrl}`);
    content = await file.text();
  } else {
    log(`Fetching skill from ${sourceUrl}...`);
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
    content = await res.text();
  }

  // Very basic regex to extract name from YAML frontmatter
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  if (!nameMatch) {
    throw new Error("Invalid SKILL.md: Could not find 'name:' in YAML frontmatter.");
  }
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, ""); // strip quotes
  const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  const hash = hasher.digest("hex");

  const destDir = join(skillsDir, safeName);
  if (!existsSync(destDir)) await mkdir(destDir, { recursive: true });
  
  const destFile = join(destDir, "SKILL.md");
  await Bun.write(destFile, content);

  // Update lockfile at process.cwd() (the project root typically)
  const cwd = process.cwd();
  const lock = await getSkillsLock(cwd);
  lock.skills[safeName] = {
    source: urlOrName,
    sourceType,
    computedHash: hash,
  };
  await saveSkillsLock(cwd, lock);

  log(`Skill "${name}" saved to ${destFile}`);
}

async function listSkills(log: (msg: string) => void) {
  const lock = await getSkillsLock(process.cwd());
  const skillNames = Object.keys(lock.skills);
  if (skillNames.length === 0) {
    log("No skills installed.");
    return;
  }
  log("Installed skills:");
  for (const [name, entry] of Object.entries(lock.skills)) {
    log(`  - ${name} (from ${entry.sourceType}: ${entry.source})`);
  }
}

async function removeSkill(name: string, log: (msg: string) => void) {
  if (!name) throw new Error("Usage: alineo skills remove <name>");
  
  const config = await readConfig();
  const destDir = join(config.skillsDir, name);
  
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }

  const cwd = process.cwd();
  const lock = await getSkillsLock(cwd);
  if (lock.skills[name]) {
    delete lock.skills[name];
    await saveSkillsLock(cwd, lock);
    log(`Removed skill: ${name}`);
  } else {
    log(`Skill ${name} was not found in skills-lock.json`);
  }
}

async function updateSkill(name: string, log: (msg: string) => void) {
  if (!name) throw new Error("Usage: alineo skills update <name>");

  const cwd = process.cwd();
  const lock = await getSkillsLock(cwd);
  const entry = lock.skills[name];
  if (!entry) throw new Error(`Skill "${name}" is not installed. Run: alineo skills add ${name}`);

  // Resolve the URL to re-fetch from
  let fetchUrl = entry.source;
  if (entry.sourceType === "well-known") {
    fetchUrl = WELL_KNOWN[entry.source] ?? entry.source;
  }
  if (entry.sourceType === "local") {
    throw new Error(`Skill "${name}" was installed from a local file and cannot be auto-updated.`);
  }

  log(`Re-fetching skill "${name}" from ${fetchUrl}...`);
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
  const content = await res.text();

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  const newHash = hasher.digest("hex");

  if (newHash === entry.computedHash) {
    log(`Skill "${name}" is already up to date.`);
    return;
  }

  const config = await readConfig();
  const destFile = join(config.skillsDir, name, "SKILL.md");
  await Bun.write(destFile, content);

  lock.skills[name] = { ...entry, computedHash: newHash };
  await saveSkillsLock(cwd, lock);
  log(`Skill "${name}" updated successfully.`);
}

async function infoSkill(name: string, log: (msg: string) => void) {
  if (!name) throw new Error("Usage: alineo skills info <name>");

  const cwd = process.cwd();
  const lock = await getSkillsLock(cwd);
  const entry = lock.skills[name];
  if (!entry) throw new Error(`Skill "${name}" is not installed. Run: alineo skills add ${name}`);

  const config = await readConfig();
  const skillFile = join(config.skillsDir, name, "SKILL.md");

  log(`Skill: ${name}`);
  log(`  Source:      ${entry.source} (${entry.sourceType})`);
  log(`  Hash:        ${entry.computedHash}`);
  log(`  Installed:   ${skillFile}`);
  log(`  File exists: ${existsSync(skillFile) ? "yes" : "no (missing — try: alineo skills update " + name + ")"}`);
}

export const skillsCommand: CliCommand = {
  name: "skills",
  group: "sdk",
  variants: [
    { usage: "alineo skills add <url-or-name>", summary: "Fetch and save a skill locally" },
    { usage: "alineo skills list", summary: "List installed skills" },
    { usage: "alineo skills remove <name>", summary: "Remove an installed skill" },
    { usage: "alineo skills update <name>", summary: "Re-fetch and update an installed skill" },
    { usage: "alineo skills info <name>", summary: "Show metadata for an installed skill" },
  ],
  run: async (argv) => {
    const subcmd = argv[0];
    const arg = argv.slice(1).find((a) => !a.startsWith("--"));
    const log = console.log;

    if (subcmd === "add") {
      await addSkill(arg ?? "", log);
    } else if (subcmd === "list") {
      await listSkills(log);
    } else if (subcmd === "remove") {
      await removeSkill(arg ?? "", log);
    } else if (subcmd === "update") {
      await updateSkill(arg ?? "", log);
    } else if (subcmd === "info") {
      await infoSkill(arg ?? "", log);
    } else {
      throw new Error("Usage: alineo skills <add|list|remove|update|info>");
    }
  },
};
