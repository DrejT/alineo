import { existsSync, readdirSync, statSync } from "fs";
import { mkdir, rm, readdir, stat, readFile, copyFile } from "fs/promises";
import { join, dirname, relative, basename } from "path";
import { readConfig } from "../config.js";
import { hasFlag } from "./args.js";
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
  files?: string[];
}

interface SkillsLock {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

async function getSkillsLock(skillsDir: string): Promise<SkillsLock> {
  const lockPath = join(dirname(skillsDir), "skills-lock.json");
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

async function saveSkillsLock(skillsDir: string, lock: SkillsLock): Promise<void> {
  const lockPath = join(dirname(skillsDir), "skills-lock.json");
  await Bun.write(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

async function confirmPrompt(msg: string): Promise<boolean> {
  process.stdout.write(msg + " ");
  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    return false;
  }
  return false;
}

async function addSkill(urlOrName: string, log: (msg: string) => void, opts: { yes?: boolean } = {}) {
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

  // Detect if the source is a directory (local dir or GitHub tree URL)
  const isLocalDir = sourceType === "local" && existsSync(sourceUrl) && statSync(sourceUrl).isDirectory();
  const ghTree = sourceType === "url" ? parseGitHubTreeUrl(sourceUrl) : null;
  const isBundle = isLocalDir || ghTree !== null;

  if (isBundle) {
    await addSkillBundle(sourceUrl, sourceType, isLocalDir, ghTree, skillsDir, log, opts);
    return;
  }

  // --- Single-file install (original path) ---
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

  if (sourceType !== "well-known" && !opts.yes) {
    const preview = content.split("\n").slice(0, 15).join("\n");
    const confirmed = await confirmPrompt(
      `\n\u26A0 This skill is not from a well-known source.\n` +
      `  Source: ${sourceUrl}\n` +
      `  Once installed, its instructions are automatically loaded into your agent's\n` +
      `  context \u2014 treat it the way you'd treat a dependency, not a text file.\n\n` +
      `  Preview (first 15 lines):\n` +
      `  ---\n${preview}\n  ---\n\n` +
      `  Install anyway? [y/N]`
    );
    if (!confirmed) {
      log("Aborted.");
      return;
    }
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

  // Update lockfile
  const lock = await getSkillsLock(skillsDir);
  lock.skills[safeName] = {
    source: urlOrName,
    sourceType,
    computedHash: hash,
  };
  await saveSkillsLock(skillsDir, lock);

  log(`Skill "${name}" saved to ${destFile}`);
}

// ---------------------------------------------------------------------------
// Phase 2 — Multi-file bundle helpers
// ---------------------------------------------------------------------------

interface GitHubTreeInfo {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

function parseGitHubTreeUrl(url: string): GitHubTreeInfo | null {
  // Matches: https://github.com/<owner>/<repo>/tree/<branch>/<path>
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], path: m[4] };
}

async function fetchGitHubTreeFiles(
  tree: GitHubTreeInfo,
  log: (msg: string) => void,
): Promise<{ path: string; content: string }[]> {
  const apiUrl = `https://api.github.com/repos/${tree.owner}/${tree.repo}/contents/${tree.path}?ref=${tree.branch}`;
  log(`Fetching directory listing from GitHub API...`);
  const res = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);

  const items: Array<{ name: string; path: string; type: string; download_url: string | null }> =
    await res.json();

  const files: { path: string; content: string }[] = [];

  for (const item of items) {
    if (item.type === "file" && item.download_url) {
      const fileRes = await fetch(item.download_url);
      if (!fileRes.ok) continue;
      // path relative to the skill root
      const relPath = item.path.startsWith(tree.path + "/")
        ? item.path.slice(tree.path.length + 1)
        : item.name;
      files.push({ path: relPath, content: await fileRes.text() });
    } else if (item.type === "dir") {
      // Recurse into subdirectory
      const subTree: GitHubTreeInfo = { ...tree, path: item.path };
      const subFiles = await fetchGitHubTreeFiles(subTree, log);
      for (const sf of subFiles) {
        const relPath = item.path.startsWith(tree.path + "/")
          ? item.path.slice(tree.path.length + 1) + "/" + sf.path
          : item.name + "/" + sf.path;
        files.push({ path: relPath, content: sf.content });
      }
    }
  }

  return files;
}

async function collectLocalDirFiles(dirPath: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await collectLocalDirFiles(fullPath);
      for (const sf of subFiles) {
        files.push({ path: join(entry.name, sf.path), content: sf.content });
      }
    } else if (entry.isFile()) {
      files.push({ path: entry.name, content: await Bun.file(fullPath).text() });
    }
  }
  return files;
}

async function addSkillBundle(
  source: string,
  sourceType: SkillLockEntry["sourceType"],
  isLocalDir: boolean,
  ghTree: GitHubTreeInfo | null,
  skillsDir: string,
  log: (msg: string) => void,
  opts: { yes?: boolean },
) {
  let files: { path: string; content: string }[];

  if (isLocalDir) {
    files = await collectLocalDirFiles(source);
  } else if (ghTree) {
    files = await fetchGitHubTreeFiles(ghTree, log);
  } else {
    throw new Error("Unexpected bundle source.");
  }

  // Find SKILL.md among the fetched files
  const skillMd = files.find((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"));
  if (!skillMd) {
    throw new Error("No SKILL.md found in the skill bundle directory.");
  }

  // Trust gate
  if (sourceType !== "well-known" && !opts.yes) {
    const preview = skillMd.content.split("\n").slice(0, 15).join("\n");
    const confirmed = await confirmPrompt(
      `\n\u26A0 This skill bundle is not from a well-known source.\n` +
      `  Source: ${source}\n` +
      `  ${files.length} file(s) will be installed.\n` +
      `  Once installed, its instructions are automatically loaded into your agent's\n` +
      `  context \u2014 treat it the way you'd treat a dependency, not a text file.\n\n` +
      `  Preview of SKILL.md (first 15 lines):\n` +
      `  ---\n${preview}\n  ---\n\n` +
      `  Install anyway? [y/N]`
    );
    if (!confirmed) {
      log("Aborted.");
      return;
    }
  }

  const nameMatch = skillMd.content.match(/^name:\s*(.+)$/m);
  if (!nameMatch) {
    throw new Error("Invalid SKILL.md: Could not find 'name:' in YAML frontmatter.");
  }
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
  const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(skillMd.content);
  const hash = hasher.digest("hex");

  const destDir = join(skillsDir, safeName);
  const installedFiles: string[] = [];

  for (const file of files) {
    const destPath = join(destDir, file.path);
    const destParent = dirname(destPath);
    if (!existsSync(destParent)) await mkdir(destParent, { recursive: true });
    await Bun.write(destPath, file.content);
    installedFiles.push(file.path);
  }

  const lock = await getSkillsLock(skillsDir);
  lock.skills[safeName] = {
    source,
    sourceType,
    computedHash: hash,
    files: installedFiles,
  };
  await saveSkillsLock(skillsDir, lock);

  log(`Skill "${name}" installed (${installedFiles.length} files) to ${destDir}`);
}

async function listSkills(log: (msg: string) => void) {
  const config = await readConfig();
  const lock = await getSkillsLock(config.skillsDir);
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
  const lock = await getSkillsLock(config.skillsDir);
  const entryKey = lock.skills[name] ? name : name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  
  const destDir = join(config.skillsDir, entryKey);
  
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }

  if (lock.skills[entryKey]) {
    delete lock.skills[entryKey];
    await saveSkillsLock(config.skillsDir, lock);
    log(`Removed skill: ${entryKey}`);
  } else {
    log(`Skill ${name} was not found in skills-lock.json`);
  }
}

async function updateSkill(name: string, log: (msg: string) => void) {
  if (!name) throw new Error("Usage: alineo skills update <name>");

  const config = await readConfig();
  const lock = await getSkillsLock(config.skillsDir);
  const entryKey = lock.skills[name] ? name : name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const entry = lock.skills[entryKey];
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

  const destFile = join(config.skillsDir, entryKey, "SKILL.md");
  await Bun.write(destFile, content);

  lock.skills[entryKey] = { ...entry, computedHash: newHash };
  await saveSkillsLock(config.skillsDir, lock);
  log(`Skill "${name}" updated successfully.`);
}

async function infoSkill(name: string, log: (msg: string) => void) {
  if (!name) throw new Error("Usage: alineo skills info <name>");

  const config = await readConfig();
  const lock = await getSkillsLock(config.skillsDir);
  const entryKey = lock.skills[name] ? name : name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const entry = lock.skills[entryKey];
  if (!entry) throw new Error(`Skill "${name}" is not installed. Run: alineo skills add ${name}`);

  const skillFile = join(config.skillsDir, entryKey, "SKILL.md");

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
    { usage: "alineo skills add <url-or-name> -y", summary: "Skip confirmation prompt" },
    { usage: "alineo skills list", summary: "List installed skills" },
    { usage: "alineo skills remove <name>", summary: "Remove an installed skill" },
    { usage: "alineo skills update <name>", summary: "Re-fetch and update an installed skill" },
    { usage: "alineo skills info <name>", summary: "Show metadata for an installed skill" },
    { usage: "alineo skills create <name>", summary: "Scaffold a new skill directory" },
    { usage: "alineo skills validate [name]", summary: "Lint installed skills" },
  ],
  run: async (argv) => {
    const subcmd = argv[0];
    const arg = argv.slice(1).find((a) => !a.startsWith("--") && !a.startsWith("-"));
    const log = console.log;

    if (subcmd === "add") {
      const yes = hasFlag(argv, "-y") || hasFlag(argv, "--yes");
      await addSkill(arg ?? "", log, { yes });
    } else if (subcmd === "list") {
      await listSkills(log);
    } else if (subcmd === "remove") {
      await removeSkill(arg ?? "", log);
    } else if (subcmd === "update") {
      await updateSkill(arg ?? "", log);
    } else if (subcmd === "info") {
      await infoSkill(arg ?? "", log);
    } else if (subcmd === "create") {
      const { createSkill } = await import("./skills-create.js");
      await createSkill(arg ?? "", log);
    } else if (subcmd === "validate") {
      const { validateSkills } = await import("./skills-validate.js");
      await validateSkills(arg, log);
    } else {
      throw new Error("Usage: alineo skills <add|list|remove|update|info|create|validate>");
    }
  },
};
