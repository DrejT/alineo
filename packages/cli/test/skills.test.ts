import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rm } from "fs/promises";
import * as configMod from "../src/config.js";
import { skillsCommand } from "../src/commands/skills.js";

describe("skills command", () => {
  let tmpDir: string;
  let originalCwd: string;
  let logOutput: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "alineo-skills-"));
    process.chdir(tmpDir);

    const config = {
      serverUrl: "http://127.0.0.1:8080",
      useServerProxy: true,
      apiKey: "",
      adapterPath: join(tmpDir, "ledger.db"),
      agentsDir: join(tmpDir, "agents"),
      skillsDir: join(tmpDir, "skills"),
      defaults: { resources: { cpu: "1000m", memory: "1Gi" } },
    };
    
    // Write config file so readConfig picks it up
    writeFileSync("alineo.config.json", JSON.stringify(config));

    logOutput = [];
    console.log = (...args: any[]) => {
      logOutput.push(args.join(" "));
    };
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("add from local source writes sanitized folder and lock entry", async () => {
    // Create a local skill
    const localSkillPath = join(tmpDir, "local-skill.md");
    writeFileSync(localSkillPath, `---
name: My Local Skill!
description: test
---
content
`);

    await skillsCommand.run(["add", localSkillPath, "-y"]);

    // Should create folder 'my-local-skill-'
    const destDir = join(tmpDir, "skills", "my-local-skill-");
    expect(existsSync(destDir)).toBe(true);
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);

    // Lockfile should contain entry
    const lockfile = await Bun.file(join(tmpDir, "skills-lock.json")).json();
    expect(lockfile.skills["my-local-skill-"]).toBeDefined();
    expect(lockfile.skills["my-local-skill-"].source).toBe(localSkillPath);
    expect(lockfile.skills["my-local-skill-"].sourceType).toBe("local");
  });

  it("remove after add finds folder via lock key despite casing differences", async () => {
    const localSkillPath = join(tmpDir, "local-skill2.md");
    writeFileSync(localSkillPath, `---
name: uppercase-SKILL
description: test
---
content
`);

    await skillsCommand.run(["add", localSkillPath, "-y"]);

    let destDir = join(tmpDir, "skills", "uppercase-skill");
    expect(existsSync(destDir)).toBe(true);

    // Remove with different casing
    await skillsCommand.run(["remove", "uppercase-SKILL"]);

    expect(existsSync(destDir)).toBe(false);
    const lockfile = await Bun.file(join(tmpDir, "skills-lock.json")).json();
    expect(lockfile.skills["uppercase-skill"]).toBeUndefined();
  });

  it("update on a local-sourced skill throws", async () => {
    const localSkillPath = join(tmpDir, "local-skill3.md");
    writeFileSync(localSkillPath, `---
name: test-update-local
description: test
---
`);

    await skillsCommand.run(["add", localSkillPath, "-y"]);
    
    let error: any;
    try {
      await skillsCommand.run(["update", "test-update-local"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.message).toContain("cannot be auto-updated");
  });

});
