/**
 * Packs a local, unpublished/not-yet-published workspace package into a `SetupStep` that
 * installs it inside a sandbox from its own built tarball, instead of `npm install`ing the
 * published version. `bun pm pack` (not `npm pack`) because it resolves `workspace:*` ranges
 * to concrete versions in the packed package.json, matching what
 * `scripts/resolve-workspace-protocol.ts` does by hand for the real npm-publish path (see
 * that script's own comment: plain `npm pack`/`npm publish` ships a literal "workspace:*"
 * string, which breaks installation entirely outside this monorepo).
 *
 * Ultimately needs to land in `/node_modules` — the one location guaranteed to be on Bun's
 * module resolution path from *any* working directory a sandboxed bash tool call might use,
 * since resolution walks up from cwd to `/node_modules` as its final fallback (a global npm
 * install would not be found by `Bun.resolveSync(specifier, process.cwd())` unless cwd
 * happened to already be inside npm's global lib directory). `npm install --prefix /`
 * directly hits a real npm bug there ("Tracker \"idealTree\" already exists" — npm's arborist
 * chokes specifically on the filesystem root as an install prefix; any other directory works
 * fine) — so this installs into a scratch directory first, then copies the resulting
 * `node_modules` tree into `/node_modules` as a separate step.
 *
 * Ported from `drej-private/examples/agent-browser-master/pack-local-package.ts` (2026-09-11)
 * — same logic, `alineo`-scoped naming. See its own git history for prior art / usage.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

export interface SetupStep {
  name: string;
  run: string;
  cwd?: string;
}

/**
 * Packs a *chain* of local packages where a later one depends on an earlier one (e.g.
 * `alineo-cli` depends on `alineo`, which depends on `@alineo-labs/core`, etc.) and every one
 * of them needs to be the exact local build — not whatever published npm version `bun pm
 * pack` would otherwise resolve `workspace:*` down to. `npm install <tarball>` has no way to
 * know "use this other local tarball for that dependency" on its own; it would just fetch the
 * published version from the registry, silently defeating the whole point when testing a fix
 * that lives in a dependency rather than the top-level package. So after packing, each
 * tarball's own `package.json` is rewritten in place (extract, edit, re-tar) to point any
 * dependency matching another package *in this same call* at a `file:` reference to that
 * sibling's tarball path inside the sandbox, before any of them are installed.
 *
 * `pkgDirs` order doesn't matter for the rewriting itself (every tarball is packed and
 * inspected before any rewriting happens), but `entryPkgDir` — the one actually `npm install
 * -g`'d — must be the final consumer (e.g. `packages/cli`, not `packages/agent`), since npm
 * resolves its `file:` dependencies transitively during that one install.
 *
 * Returns one `SetupStep` per tarball write plus a final install step, NOT a single combined
 * step — combining every base64 write and the `npm install -g` into one giant multi-hundred-KB
 * `sb.exec()` command silently fails somewhere in the exec transport (confirmed live in
 * `drej-private`, not by inspection): the step reports success but the binary never actually
 * lands. Splitting into separate exec() calls works reliably.
 */
export async function packLocalPackagesForGlobalInstall(
  pkgDirs: string[],
  entryPkgDir: string,
): Promise<SetupStep[]> {
  const destDir = await mkdtemp(join(tmpdir(), "alineo-pack-multi-"));
  try {
    const packed: { name: string; version: string; tgzPath: string; remotePath: string }[] = [];

    for (const dir of pkgDirs) {
      const pkgJson = await Bun.file(join(dir, "package.json")).json();
      const pkgDestDir = join(destDir, "pack", pkgJson.name.replace(/[^a-z0-9-]/gi, "_"));
      await mkdir(pkgDestDir, { recursive: true });
      if (pkgJson.scripts?.build) {
        await $`bun run build`.cwd(dir).quiet();
      }
      await $`bun pm pack --destination ${pkgDestDir}`.cwd(dir).quiet();
      const [tgzName] = (await readdir(pkgDestDir)).filter((f) => f.endsWith(".tgz"));
      if (!tgzName)
        throw new Error(`bun pm pack produced no .tgz in ${pkgDestDir} for ${pkgJson.name}`);
      packed.push({
        name: pkgJson.name,
        version: pkgJson.version,
        tgzPath: join(pkgDestDir, tgzName),
        remotePath: `/tmp/${tgzName}`,
      });
    }

    // Rewrite each tarball's package.json: any dependency matching another package in this same
    // batch becomes a `file:` reference to that sibling's remote path, instead of whatever plain
    // semver `bun pm pack` resolved `workspace:*` down to.
    for (const pkg of packed) {
      const extractDir = join(destDir, "extract", pkg.name.replace(/[^a-z0-9-]/gi, "_"));
      await mkdir(extractDir, { recursive: true });
      await $`tar xzf ${pkg.tgzPath} -C ${extractDir}`.quiet();
      const pkgJsonPath = join(extractDir, "package", "package.json");
      const pkgJson = await Bun.file(pkgJsonPath).json();
      let changed = false;
      for (const sibling of packed) {
        if (sibling.name === pkg.name) continue;
        if (pkgJson.dependencies?.[sibling.name] !== undefined) {
          pkgJson.dependencies[sibling.name] = `file:${sibling.remotePath}`;
          changed = true;
        }
      }
      if (changed) {
        await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
        // Plain `tar czf` embeds the just-extracted files' mtimes and gzip's own MTIME
        // header, both of which differ on every invocation even for byte-identical source —
        // that non-determinism propagates into this step's `run` string (the tarball is
        // base64-embedded there), which would poison computeSetupHash() for the whole spec.
        // Pinning sort order, ownership, and mtime makes repeated packs of unchanged source
        // byte-identical.
        await $`tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' -czf ${pkg.tgzPath} -C ${extractDir} package`.quiet();
      }
    }

    const entryPkgJson = await Bun.file(join(entryPkgDir, "package.json")).json();
    const entryPkg = packed.find((p) => p.name === entryPkgJson.name);
    if (!entryPkg) throw new Error(`entryPkgDir ${entryPkgDir} not found among packed pkgDirs`);

    const writeSteps = await Promise.all(
      packed.map(async (pkg) => {
        const tarball = await readFile(pkg.tgzPath);
        const b64 = tarball.toString("base64");
        const eof = `ALINEO_PKG_${pkg.name.replace(/[^A-Z0-9]/gi, "_").toUpperCase()}_EOF`;
        return {
          name: `Write local ${pkg.name}@${pkg.version} tarball into the sandbox`,
          run: `base64 -d <<'${eof}' > ${pkg.remotePath}\n${b64}\n${eof}`,
        };
      }),
    );

    return [
      ...writeSteps,
      {
        name: `Install ${entryPkg.name} from local build (resolving ${packed.map((p) => p.name).join(", ")} from the tarballs just written, not the registry)`,
        run: `npm install -g ${entryPkg.remotePath}`,
      },
    ];
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
}

/** Same idea as `packLocalPackagesForGlobalInstall`, for a single package with no local siblings. */
export async function packLocalPackageSetupStep(pkgDir: string): Promise<SetupStep> {
  const pkgJson = await Bun.file(join(pkgDir, "package.json")).json();
  const pkgName: string = pkgJson.name;

  const destDir = await mkdtemp(join(tmpdir(), "alineo-pack-"));
  try {
    if (pkgJson.scripts?.build) {
      await $`bun run build`.cwd(pkgDir).quiet();
    }
    await $`bun pm pack --destination ${destDir}`.cwd(pkgDir).quiet();
    const [tgzName] = (await readdir(destDir)).filter((f) => f.endsWith(".tgz"));
    if (!tgzName) throw new Error(`bun pm pack produced no .tgz in ${destDir} for ${pkgName}`);

    const tarball = await readFile(join(destDir, tgzName));
    const b64 = tarball.toString("base64");
    const remotePath = `/tmp/${tgzName}`;
    const scratchPrefix = "/tmp/alineo-local-pkg-install";

    return {
      name: `Install ${pkgName} from local build (private package, not published to npm)`,
      run:
        `base64 -d <<'ALINEO_LOCAL_PKG_EOF' > ${remotePath}\n${b64}\nALINEO_LOCAL_PKG_EOF\n` +
        `mkdir -p ${scratchPrefix} && npm install --no-save --prefix ${scratchPrefix} ${remotePath} && ` +
        `mkdir -p /node_modules && cp -r ${scratchPrefix}/node_modules/. /node_modules/`,
    };
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
}
