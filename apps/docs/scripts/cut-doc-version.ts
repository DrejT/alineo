#!/usr/bin/env bun
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { epochVersion, latestVersion, PRODUCTS, urlVersion } from "./doc-versions";

/**
 * Keeps the versioned doc trees (`content/docs/{core,alineo}/vX.Y/`) in lockstep
 * with the docs epoch — the published `major.minor` of `@alineo-labs/sandbox` (see
 * `epochVersion()` in doc-versions.ts). This is the automation
 * `plans/versioned-docs.md` originally left as "manual and deliberate for now";
 * manual-and-deliberate missed the cut at 0.2.0 (PRs #193/#194) and again at 0.3.0
 * (PR #223), each time via a feature PR editing the current-latest folder in place
 * instead of adding a new one.
 *
 *   bun scripts/cut-doc-version.ts            cut the new folders if the epoch moved
 *   bun scripts/cut-doc-version.ts --check    exit 1 if a cut is owed (CI guard); no writes
 *
 * A cut is a `cp -r` of the current latest folder with its own internal
 * `/docs/<product>/<oldMinor>/…` links repointed to the new minor — exactly the
 * by-hand steps from PR #223, nothing more. The new folder is a starting point:
 * whoever documents that release's changes then edits it. Wired into the release
 * flow via the root `release:version` script (changesets/action's `version:`
 * command), so the `chore: version packages` PR always carries the matching folder.
 */

// Run everything relative to apps/docs, like the sibling sync-*.ts scripts — this
// script is also invoked from the repo root (`bun apps/docs/scripts/...`).
process.chdir(path.join(import.meta.dirname, ".."));

const check = process.argv.includes("--check");

function repointLinks(dir: string, from: string, to: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      repointLinks(full, from, to);
      continue;
    }
    if (!/\.(mdx?|json)$/.test(entry.name)) continue;
    const original = readFileSync(full, "utf8");
    // Rewrite only this product's own self-links at the *old epoch minor*. A link
    // that deliberately points at an older frozen version stays as written — a
    // fresh copy of the latest folder has none, but a later hand-edit might, so
    // the match is scoped to the two epoch minors, not "any /0.x/".
    const updated = original
      .split(`/docs/core/${from}/`)
      .join(`/docs/core/${to}/`)
      .split(`/docs/alineo/${from}/`)
      .join(`/docs/alineo/${to}/`);
    if (updated !== original) writeFileSync(full, updated);
  }
}

const epoch = epochVersion(); // e.g. "0.3"
const owed: string[] = [];
let wrote = false;

for (const product of PRODUCTS) {
  const latest = latestVersion(product); // "v0.2"
  const latestMinor = urlVersion(latest); // "0.2"
  if (latestMinor === epoch) continue; // already current

  const [lMaj, lMin] = latestMinor.split(".").map(Number);
  const [eMaj, eMin] = epoch.split(".").map(Number);
  if (eMaj < lMaj || (eMaj === lMaj && eMin < lMin)) {
    throw new Error(
      `content/docs/${product}: latest folder ${latest} is AHEAD of the epoch ` +
        `(@alineo-labs/sandbox ${epoch}) — a folder was added by hand, or the epoch package regressed.`,
    );
  }

  owed.push(`content/docs/${product}/v${epoch}`);
  if (check) continue;

  const dest = path.join("content/docs", product, `v${epoch}`);
  if (statSync(dest, { throwIfNoEntry: false })) {
    throw new Error(`${dest} already exists but is not the discovered latest — inconsistent state`);
  }
  cpSync(path.join("content/docs", product, latest), dest, { recursive: true });
  repointLinks(dest, latestMinor, epoch);
  wrote = true;
  console.log(`[cut-doc-version] ${product}: ${latest} -> v${epoch} (copied, links repointed)`);
}

if (owed.length === 0) {
  console.log(
    `[cut-doc-version] up to date — epoch @alineo-labs/sandbox ${epoch}, all trees at v${epoch}`,
  );
  process.exit(0);
}

if (check) {
  const on = PRODUCTS.map((p) => urlVersion(latestVersion(p))).join(" / ");
  console.error(
    `\n[cut-doc-version] a docs version cut is owed for the ${epoch} release:\n` +
      owed.map((p) => `  - ${p}/  (missing)`).join("\n") +
      `\n\n@alineo-labs/sandbox is at ${epoch} but the docs are still on ${on}.\n` +
      `Run \`bun apps/docs/scripts/cut-doc-version.ts\` to cut them, then edit the new\n` +
      `folder(s) to document what changed. See plans/versioned-docs.md.\n`,
  );
  process.exit(1);
}

if (wrote) {
  // Regenerate everything derived from the folder set (importing runs each script).
  await import("./sync-doc-versions.ts");
  await import("./sync-redirects.ts");
}
console.log(`[cut-doc-version] done — new latest is v${epoch}`);
