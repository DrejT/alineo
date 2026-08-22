import { readdirSync } from "node:fs";
import path from "node:path";

// Shared by source.config.ts (build one defineDocs() per discovered version) and
// next.config.ts (regenerate public/_redirects's "latest" targets) so a version
// cut is just "add content/docs/<product>/vX.Y/" — nothing here or in either
// config file needs hand-editing to pick it up. See plans/versioned-docs.md.
const VERSION_DIR = /^v(\d+)\.(\d+)$/;

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
