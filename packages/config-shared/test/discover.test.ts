import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig, PROJECT_CONFIG_FILE } from "../src/discover";

const roots: string[] = [];

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "alineo-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("findProjectConfig", () => {
  test("finds a config in the starting directory", () => {
    const root = makeTree();
    const file = join(root, PROJECT_CONFIG_FILE);
    writeFileSync(file, "{}");
    expect(findProjectConfig(root)).toBe(file);
  });

  test("walks up from a subdirectory — the cwd-only bug this replaces", () => {
    const root = makeTree();
    const file = join(root, PROJECT_CONFIG_FILE);
    writeFileSync(file, "{}");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findProjectConfig(deep)).toBe(file);
  });

  test("stops at a .git boundary instead of escaping the project", () => {
    const root = makeTree();
    // A config above the project boundary must NOT be picked up.
    writeFileSync(join(root, PROJECT_CONFIG_FILE), "{}");
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "src");
    mkdirSync(deep, { recursive: true });
    expect(findProjectConfig(deep)).toBeNull();
  });

  test("still finds a config that sits next to .git", () => {
    const root = makeTree();
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const file = join(project, PROJECT_CONFIG_FILE);
    writeFileSync(file, "{}");
    const deep = join(project, "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(findProjectConfig(deep)).toBe(file);
  });

  test("returns null when nothing is found", () => {
    const root = makeTree();
    const deep = join(root, "x", "y");
    mkdirSync(deep, { recursive: true });
    expect(findProjectConfig(deep)).toBeNull();
  });
});
