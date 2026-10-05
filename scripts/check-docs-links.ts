#!/usr/bin/env bun
// Usage: bun scripts/check-docs-links.ts
//
// Fails the build when a docs link or a redirect points at a page that does not exist.
//
// Nothing else catches this. `next build` does not validate links inside MDX, and
// `apps/docs/public/_redirects` is read only by Cloudflare Pages, after deploy — so a page
// move with one wrong path builds green and becomes a 404 that a reader finds. Four checks:
//
//   1. Links     — every `/docs/...` link in docs and blog MDX, in the docs app's own source,
//                  and every `docs.alineo.tech/docs/...` URL anywhere in the repo resolves to
//                  a live page. A link that only works through a redirect fails too: the
//                  redirect is for URLs we no longer control, not for ones we write today.
//   2. Targets   — every `_redirects` target is a live page.
//   3. Chains    — no `_redirects` target is itself a redirect source. One hop, always.
//   4. Shadowing — no `_redirects` source is a live page. Cloudflare applies the rule before
//                  serving the file, so a rule on a live URL silently hides that page.
//
// Routes are derived from the content tree rather than from a build, so this runs in the CI
// check job in under a second without `next build`: one fumadocs collection per directory
// under `content/docs/`, served at `/docs/<collection>/<path>`, `index.mdx` at its folder.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOCS_APP = join(ROOT, "apps/docs");
const CONTENT = join(DOCS_APP, "content/docs");
const BLOG = join(DOCS_APP, "content/blog");
const PUBLIC = join(DOCS_APP, "public");
const APP = join(DOCS_APP, "src/app");
const REDIRECTS = join(PUBLIC, "_redirects");

const failures: string[] = [];

/**
 * Redirect sources that are deliberately also live pages, each with the reason. `/` is one:
 * a static export cannot answer `/` with a real 301 (see the comment on that rule), so the
 * edge rule exists precisely to take over a URL that `page.tsx` also serves.
 */
const SHADOW_ALLOWLIST = new Map([["/", "static export cannot 301 the root; the edge rule does"]]);

// ------------------------------------------------------------------------------ routes

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const routes = new Set<string>();

for (const file of new Bun.Glob("**/*.mdx").scanSync({ cwd: CONTENT })) {
  const withoutExt = file.replace(/\.mdx$/, "");
  const path =
    withoutExt === "index" || withoutExt.endsWith("/index")
      ? withoutExt.replace(/\/?index$/, "")
      : withoutExt;
  routes.add(stripTrailingSlash(`/docs/${path}`));
}

for (const file of new Bun.Glob("*.mdx").scanSync({ cwd: BLOG })) {
  routes.add(`/blog/${file.replace(/\.mdx$/, "")}`);
}

// Static app pages: every `page.tsx` without a dynamic segment. The dynamic ones are the docs
// collections and blog posts, both covered above.
for (const file of new Bun.Glob("**/page.tsx").scanSync({ cwd: APP })) {
  if (file.includes("[")) continue;
  const dir = file.replace(/\/?page\.tsx$/, "");
  routes.add(dir === "" ? "/" : `/${dir}`);
}

const collections = new Set(
  [...routes].filter((r) => r.startsWith("/docs/")).map((r) => r.split("/")[2]),
);

// ------------------------------------------------------------------------------ redirects

interface Rule {
  line: number;
  from: string;
  to: string;
}

const rules: Rule[] = [];
readFileSync(REDIRECTS, "utf8")
  .split("\n")
  .forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [from, to] = line.split(/\s+/);
    if (!from || !to) {
      failures.push(`_redirects:${index + 1}: cannot parse "${line}"`);
      return;
    }
    rules.push({ line: index + 1, from, to });
  });

const exactSources = new Set(rules.filter((r) => !r.from.endsWith("/*")).map((r) => r.from));
const splatSources = rules.filter((r) => r.from.endsWith("/*")).map((r) => r.from.slice(0, -1));

function isRedirectSource(path: string): boolean {
  return exactSources.has(path) || splatSources.some((prefix) => path.startsWith(prefix));
}

for (const rule of rules) {
  const where = `_redirects:${rule.line} (${rule.from} → ${rule.to})`;

  // A `:splat` target can only be checked at its fixed prefix; the rest is the caller's path.
  const target = stripTrailingSlash(rule.to.replace(/\/?:splat$/, ""));
  if (!routes.has(target)) failures.push(`${where}: target is not a live page`);
  else if (isRedirectSource(target)) failures.push(`${where}: target is itself redirected`);

  if (!rule.from.endsWith("/*") && routes.has(rule.from) && !SHADOW_ALLOWLIST.has(rule.from)) {
    failures.push(`${where}: source is a live page — the rule would hide it`);
  }
}

// ------------------------------------------------------------------------------ links

/** A link we check: a root-relative docs path, with its anchor and query dropped. */
function normalise(href: string): string | undefined {
  const path = href.split("#")[0]!.split("?")[0]!;
  if (!path.startsWith("/docs/") && path !== "/docs") return undefined;
  return stripTrailingSlash(path);
}

function checkLink(file: string, href: string): void {
  const path = normalise(href);
  if (path === undefined) return;
  // A template literal (`/docs/playground/${slug}`) is built at runtime; nothing to check here.
  if (path.includes("${")) return;
  // Assets under public/ (e.g. /docs-assets/x.gif) are served as files, not routes.
  if (existsSync(join(PUBLIC, path))) return;
  if (routes.has(path)) return;
  const segment = path.split("/")[2];
  const hint = isRedirectSource(path)
    ? "only reachable through a redirect — link the final page"
    : segment !== undefined && !collections.has(segment)
      ? `no "${segment}" collection`
      : "no such page";
  failures.push(`${relative(ROOT, file)}: ${href} — ${hint}`);
}

const MARKDOWN_LINK = /\]\((\/docs\/[^)\s]*)\)/g;
const ATTRIBUTE_LINK = /(?:href|url)[=:]\s*\{?\s*["'`](\/docs\/[^"'`\s]*)["'`]/g;
const ABSOLUTE_LINK = /https:\/\/docs\.alineo\.tech(\/docs\/[^\s)"'`>\]\\]*)/g;

let linksSeen = 0;

function scan(file: string, patterns: RegExp[]): void {
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      linksSeen++;
      checkLink(file, match[1]!.replace(/[.,;:]+$/, ""));
    }
  }
}

for (const file of new Bun.Glob("**/*.mdx").scanSync({ cwd: CONTENT, absolute: true })) {
  scan(file, [MARKDOWN_LINK, ATTRIBUTE_LINK, ABSOLUTE_LINK]);
}
for (const file of new Bun.Glob("*.mdx").scanSync({ cwd: BLOG, absolute: true })) {
  scan(file, [MARKDOWN_LINK, ATTRIBUTE_LINK, ABSOLUTE_LINK]);
}
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({
  cwd: join(DOCS_APP, "src"),
  absolute: true,
})) {
  scan(file, [ATTRIBUTE_LINK, ABSOLUTE_LINK]);
}

// Everything else in the repo that points at the live site by absolute URL: READMEs, skills,
// the registry's published JSON Schema, the docs MCP server. Tracked files only, so build
// output and node_modules never count.
const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
  .stdout.toString()
  .split("\0")
  .filter((f) => /\.(md|mdx|ts|tsx|json)$/.test(f))
  .filter((f) => !f.startsWith("apps/docs/content/") && !f.startsWith("apps/docs/src/"))
  .filter((f) => !f.endsWith("CHANGELOG.md"));
for (const file of tracked) {
  scan(join(ROOT, file), [ABSOLUTE_LINK]);
}

if (linksSeen === 0) {
  failures.push(
    "no docs links found — has the content moved? A link check that reads nothing always passes.",
  );
}

// ------------------------------------------------------------------------------ report

if (failures.length > 0) {
  console.error(`\nDocs link check failed (${failures.length}):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `docs links: ${routes.size} pages, ${rules.length} redirect rules and ${linksSeen} links check out.`,
);
