/**
 * Rewrites an agent spec so the sandbox installs **this checkout's** `alineo-cli` instead of
 * the published one.
 *
 * Every spec that spawns child agents does `npm install -g alineo-cli` in its setup, which
 * pulls whatever is on npm. That is exactly wrong while testing a branch that renames the
 * vocabulary: the published CLI writes `cli`/`cliVersion` and the old flat event names, so a
 * spec written in the new vocabulary is rejected inside the sandbox and the failure looks like
 * a spec bug rather than a version skew.
 *
 * So: pack the whole local workspace closure below `alineo-cli` with
 * `packLocalPackagesForGlobalInstall` (which rewrites each tarball's `workspace:*` deps to
 * `file:` references at its siblings, instead of letting npm fetch the published versions) and
 * substitute the resulting steps in place of the `npm install -g` one. Position is preserved —
 * later steps (`alineo.config.json`, the Pi extension copied out of `$(npm root -g)`) run
 * against the local build.
 *
 * Usage:
 *   bun scripts/local-cli-spec.ts examples/rlm-master/agents/master.json [out.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { packLocalPackagesForGlobalInstall, type SetupStep } from "./pack-local-package.ts";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY_PKG_DIR = join(ROOT, "packages/cli");

/** Every workspace package `alineo-cli` reaches, transitively — anything left out would be
 *  resolved from npm at its published version, which is the version this is avoiding. */
export async function workspaceClosure(entryDir: string): Promise<string[]> {
  const byName = new Map<string, string>();
  const root = await Bun.file(join(ROOT, "package.json")).json();
  for (const pattern of root.workspaces as string[]) {
    for (const dir of pattern.endsWith("/*")
      ? await expand(pattern.slice(0, -2))
      : [join(ROOT, pattern)]) {
      const pkg = Bun.file(join(dir, "package.json"));
      if (await pkg.exists()) byName.set((await pkg.json()).name, dir);
    }
  }

  const seen = new Set<string>();
  const queue = [entryDir];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const { dependencies = {} } = await Bun.file(join(dir, "package.json")).json();
    for (const [name, range] of Object.entries(dependencies as Record<string, string>)) {
      if (!range.startsWith("workspace:")) continue;
      const depDir = byName.get(name);
      if (!depDir) throw new Error(`${name} is a workspace: dep of ${dir} but not a workspace`);
      queue.push(depDir);
    }
  }
  return [...seen];
}

async function expand(prefix: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const base = join(ROOT, prefix);
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(base, e.name));
}

/** The packed steps, cached across calls — packing the closure costs a full build. */
let cached: SetupStep[] | undefined;
export async function localCliSetupSteps(): Promise<SetupStep[]> {
  cached ??= await packLocalPackagesForGlobalInstall(
    await workspaceClosure(ENTRY_PKG_DIR),
    ENTRY_PKG_DIR,
  );
  return cached;
}

const INSTALL_STEP = /npm install\s+(-g|--global)\s+alineo-cli\b/;

export async function withLocalCli(
  spec: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const setup = (spec.setup ?? []) as SetupStep[];
  const at = setup.findIndex((s) => INSTALL_STEP.test(s.run));
  if (at === -1) throw new Error("spec has no `npm install -g alineo-cli` setup step to replace");
  return {
    ...spec,
    setup: [...setup.slice(0, at), ...(await localCliSetupSteps()), ...setup.slice(at + 1)],
  };
}

if (import.meta.main) {
  const [specPath, outPath] = process.argv.slice(2);
  if (!specPath) throw new Error("usage: bun scripts/local-cli-spec.ts <spec.json> [out.json]");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as Record<string, unknown>;
  const rewritten = await withLocalCli(spec);
  const out = outPath ?? join(dirname(specPath), `.local-${specPath.split("/").pop()}`);
  await writeFile(out, `${JSON.stringify(rewritten, null, 2)}\n`);
  const steps = (rewritten.setup as SetupStep[]).length;
  console.log(`${out}  (${steps} setup steps, local alineo-cli packed in)`);
}
