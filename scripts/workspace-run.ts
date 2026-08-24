#!/usr/bin/env bun
// Usage: bun scripts/workspace-run.ts <build|typecheck|test>
//
// Runs <task> across every packages/** workspace, in dependency order (derived
// from "workspace:*" ranges in each package's own package.json), instead of a
// hand-maintained "&&" chain in the root package.json. A new package under
// packages/ or packages/adapters/ is picked up automatically the moment it's
// added to the root "workspaces" array and declares the relevant tsconfig.json
// (typecheck) or package.json script (build/test) — there is no second place
// left to edit, which is what let packages/adapters/flue go missing from the
// old hand-written typecheck chain.

import { dirname, join } from "node:path";

type Task = "build" | "typecheck" | "test";

const task = process.argv[2] as Task | undefined;
if (task !== "build" && task !== "typecheck" && task !== "test") {
  console.error(`Usage: bun scripts/workspace-run.ts <build|typecheck|test>`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const rootPkg = await Bun.file(join(root, "package.json")).json();

// Only packages/** — examples/* and apps/* are out of scope for these tasks,
// matching current behavior.
const packagePatterns = (rootPkg.workspaces as string[]).filter((w) => w.startsWith("packages/"));

interface Pkg {
  dir: string;
  name: string;
  json: Record<string, unknown>;
}

const packages: Pkg[] = [];
for (const pattern of packagePatterns) {
  const glob = new Bun.Glob(`${pattern}/package.json`);
  for await (const match of glob.scan({ cwd: root, absolute: true })) {
    const json = await Bun.file(match).json();
    packages.push({ dir: dirname(match), name: json.name, json });
  }
}

// Topological sort by "workspace:*" dependency edges (dependencies + devDependencies).
const byName = new Map(packages.map((p) => [p.name, p]));
const visited = new Set<string>();
const visiting = new Set<string>();
const sorted: Pkg[] = [];

function visit(pkg: Pkg): void {
  if (visited.has(pkg.name)) return;
  if (visiting.has(pkg.name)) {
    throw new Error(`Circular workspace dependency involving "${pkg.name}"`);
  }
  visiting.add(pkg.name);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg.json[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [depName, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) continue;
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
  }
  visiting.delete(pkg.name);
  visited.add(pkg.name);
  sorted.push(pkg);
}

for (const pkg of packages) visit(pkg);

async function run(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}

// typecheck resolves cross-package "workspace:*" imports against each package's built
// `types` entry point (e.g. opensandbox's package.json points "types" at dist/index.d.mts),
// not its source — so a package that hasn't been built yet is unresolvable to a dependent's
// tsc run. Build every package first (in the same topological order) so typecheck is
// self-sufficient and doesn't rely on a separate build step having already run.
if (task === "typecheck") {
  for (const pkg of sorted) {
    const scripts = pkg.json.scripts as Record<string, string> | undefined;
    if (!scripts?.build) continue;
    console.log(`\n> build ${pkg.name}`);
    const code = await run(["bun", "run", "--cwd", pkg.dir, "build"]);
    if (code !== 0) process.exit(code);
  }
}

for (const pkg of sorted) {
  if (task === "typecheck") {
    const tsconfig = join(pkg.dir, "tsconfig.json");
    if (!(await Bun.file(tsconfig).exists())) continue;
    console.log(`\n> typecheck ${pkg.name}`);
    const code = await run(["bunx", "tsc", "--noEmit", "--strict", "--project", tsconfig]);
    if (code !== 0) process.exit(code);
  } else {
    const scripts = pkg.json.scripts as Record<string, string> | undefined;
    if (!scripts?.[task]) continue;
    console.log(`\n> ${task} ${pkg.name}`);
    const code = await run(["bun", "run", "--cwd", pkg.dir, task]);
    if (code !== 0) process.exit(code);
  }
}

console.log(`\n${task}: all packages passed.`);
