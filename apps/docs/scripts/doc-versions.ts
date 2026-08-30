import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Shared by source.config.ts (build one defineDocs() per discovered version) and
// next.config.ts (regenerate public/_redirects's "latest" targets) so a version
// cut is just "add content/docs/<product>/vX.Y/" — nothing here or in either
// config file needs hand-editing to pick it up. See plans/versioned-docs.md.
const VERSION_DIR = /^v(\d+)\.(\d+)$/;

export const PRODUCTS = ["core", "alineo"] as const;
export type Product = (typeof PRODUCTS)[number];

// The single package whose published major.minor defines the docs "epoch". Both
// versioned trees (`core` = the sandbox client docs, `alineo` = the CLI docs) are
// cut *together*, numbered by this one version — the CLI is a thin wrapper over the
// SDK and has never had a doc-relevant API change that wasn't part of the same
// release, so a per-package number for it would just drift (alineo-cli is still
// 0.1.x while these folders are v0.3). If that stops being true, give `alineo` its
// own entry here. See plans/versioned-docs.md "Docs epoch".
const EPOCH_PACKAGE = "../../../packages/sdks/typescript/package.json";

/** `major.minor` of the package that defines the current docs epoch, e.g. "0.3". */
export function epochVersion(): string {
  const pkgPath = path.join(import.meta.dirname, EPOCH_PACKAGE);
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) throw new Error(`${EPOCH_PACKAGE}: unparseable version "${version}"`);
  return `${m[1]}.${m[2]}`;
}

function parse(name: string): [number, number] {
  const m = VERSION_DIR.exec(name);
  if (!m) throw new Error(`"${name}" is not a "vX.Y" version folder name`);
  return [Number(m[1]), Number(m[2])];
}

/** Version folder names for a product, e.g. ["v0.1", "v0.2"], ascending. */
export function discoverVersions(product: string, contentRoot = "content/docs"): string[] {
  const base = path.join(contentRoot, product);
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const [aMaj, aMin] = parse(a);
      const [bMaj, bMin] = parse(b);
      return aMaj - bMaj || aMin - bMin;
    });
}

/** The newest version folder for a product — last in discoverVersions()'s ascending order. */
export function latestVersion(product: string, contentRoot?: string): string {
  const versions = discoverVersions(product, contentRoot);
  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(`No "vX.Y" version folders found under content/docs/${product}`);
  }
  return latest;
}

/**
 * Folder name ("v0.1") -> URL/route segment ("0.1"). Content dirs and defineDocs()
 * exports keep the "v" prefix (matches this repo's existing naming), but URLs,
 * redirects, and the version switcher's [version] route param drop it.
 */
export function urlVersion(folderVersion: string): string {
  return folderVersion.replace(/^v/, "");
}
