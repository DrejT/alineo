#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverVersions, urlVersion } from "./doc-versions";

// Regenerates the marker-delimited "AUTO-GENERATED-VERSIONED-DOCS" blocks in
// source.config.ts and src/lib/source.ts from whatever content/docs/<product>/vX.Y/
// folders exist on disk. Both files need one *statically named* defineDocs()/
// loader() export per version — fumadocs-mdx rejects a nested object/map export,
// and ES module export names must be static text — so unlike a plain directory
// scan, a real version cut still needs this codegen pass. Run via predev/prebuild
// (package.json): a version cut is then "add the content folder, run
// `bun run build`", nothing to hand-edit in either file. See plans/versioned-docs.md.
const ROOT = path.join(import.meta.dirname, "..");
const START = "// AUTO-GENERATED-VERSIONED-DOCS:START";
const END = "// AUTO-GENERATED-VERSIONED-DOCS:END";

const PRODUCTS = ["core", "alineo"] as const;

// "core", "v0.1" -> "coreV01Docs" — matches this repo's original hand-written naming.
function ident(product: string, version: string): string {
  const suffix = version.replace(/^v/, "V").replace(/\./g, "");
  return `${product}${suffix}Docs`;
}

function splice(filePath: string, body: string) {
  const original = readFileSync(filePath, "utf8");
  const startIdx = original.indexOf(START);
  const endIdx = original.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`${path.relative(ROOT, filePath)}: missing ${START}/${END} markers`);
  }
  const updated =
    original.slice(0, startIdx) + `${START}\n${body}\n${END}` + original.slice(endIdx + END.length);
  if (updated !== original) {
    writeFileSync(filePath, updated);
    return true;
  }
  return false;
}

const versionsByProduct = Object.fromEntries(PRODUCTS.map((p) => [p, discoverVersions(p)])) as Record<
  (typeof PRODUCTS)[number],
  string[]
>;

for (const [product, versions] of Object.entries(versionsByProduct)) {
  if (versions.length === 0) {
    throw new Error(`No "vX.Y" version folders found under content/docs/${product}`);
  }
}

// --- source.config.ts: one `export const <ident> = defineDocs(...)` per version ---
const configBody = PRODUCTS.map((product) =>
  versionsByProduct[product]
    .map(
      (v) =>
        `export const ${ident(product, v)} = defineDocs({ dir: "content/docs/${product}/${v}", docs });`,
    )
    .join("\n"),
).join("\n");

// --- src/lib/source.ts: imports + one loader()-keyed-by-version registry per product ---
const sourceImports = PRODUCTS.flatMap((p) => versionsByProduct[p].map((v) => ident(p, v))).join(",\n  ");

const sourceBody = PRODUCTS.map((product) => {
  const versions = versionsByProduct[product];
  const latest = urlVersion(versions.at(-1)!);
  const entries = versions
    .map(
      (v) =>
        `  "${urlVersion(v)}": loader({ baseUrl: "/docs/${product}/${urlVersion(v)}", source: ${ident(product, v)}.toFumadocsSource() }),`,
    )
    .join("\n");
  return (
    `export const ${product}Versions = {\n${entries}\n} as const;\n` +
    `export const ${product}LatestVersion: keyof typeof ${product}Versions = "${latest}";\n` +
    `export const ${product}Source = ${product}Versions[${product}LatestVersion];`
  );
}).join("\n\n");

const configChanged = splice(path.join(ROOT, "source.config.ts"), configBody);

// source.ts's import list is hand-shaped (not just the marker body) since the
// imported names change with the version set — rewrite the whole `import { ... }
// from "collections/server"` statement, not just the marked block.
const sourcePath = path.join(ROOT, "src/lib/source.ts");
const sourceOriginal = readFileSync(sourcePath, "utf8");
const importRe = /import \{[\s\S]*?\} from "collections\/server";/;
if (!importRe.test(sourceOriginal)) {
  throw new Error(`src/lib/source.ts: couldn't find the "collections/server" import to rewrite`);
}
const staticImports = ["workflowDocs", "agentDocs", "examplesDocs", "cookbooksDocs"];
const newImport = `import {\n  ${sourceImports},\n  ${staticImports.join(",\n  ")},\n} from "collections/server";`;
const withImport = sourceOriginal.replace(importRe, newImport);
const sourceUpdated = (() => {
  const startIdx = withImport.indexOf(START);
  const endIdx = withImport.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`src/lib/source.ts: missing ${START}/${END} markers`);
  }
  return withImport.slice(0, startIdx) + `${START}\n${sourceBody}\n${END}` + withImport.slice(endIdx + END.length);
})();
const sourceChanged = sourceUpdated !== sourceOriginal;
if (sourceChanged) writeFileSync(sourcePath, sourceUpdated);

if (configChanged || sourceChanged) {
  console.log(
    `[sync-doc-versions] regenerated ${[configChanged && "source.config.ts", sourceChanged && "src/lib/source.ts"].filter(Boolean).join(", ")} — ` +
      PRODUCTS.map((p) => `${p} latest=${versionsByProduct[p].at(-1)}`).join(", "),
  );
} else {
  console.log("[sync-doc-versions] up to date");
}
