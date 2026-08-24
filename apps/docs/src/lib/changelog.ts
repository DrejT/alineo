import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ChangelogEntry {
  package: "alineo" | "alineo-cli";
  version: string;
  date: string | null; // ISO string from the npm registry, null if unresolved
  body: string; // filtered markdown for this version's section
}

interface ChangelogSource {
  package: ChangelogEntry["package"];
  npmName: string;
  // relative to the repo root (apps/docs/../..)
  changelogPath: string;
}

const SOURCES: ChangelogSource[] = [
  { package: "alineo", npmName: "alineo", changelogPath: "packages/sdks/typescript/CHANGELOG.md" },
  { package: "alineo-cli", npmName: "alineo-cli", changelogPath: "packages/cli/CHANGELOG.md" },
];

const REPO_ROOT = path.join(process.cwd(), "..", "..");

async function getPublishDates(npmName: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${npmName}`);
    if (!res.ok) return {};
    const json = (await res.json()) as { time?: Record<string, string> };
    return json.time ?? {};
  } catch {
    return {}; // offline dev build, registry hiccup — fall back to no dates, never fail the build
  }
}

/** Split a changesets CHANGELOG.md into its top-level "## <version>" sections, dropping the "# <name>" title. */
function parseSections(raw: string): { version: string; body: string }[] {
  const lines = raw.split("\n");
  const sections: { version: string; body: string[] }[] = [];
  for (const line of lines) {
    const heading = line.match(/^## (.+)/);
    if (heading) {
      sections.push({ version: heading[1].trim(), body: [] });
      continue;
    }
    if (sections.length > 0) sections.at(-1)!.body.push(line);
  }
  return sections.map((s) => ({ version: s.version, body: s.body.join("\n").trim() }));
}

/** Drop "- Updated dependencies [...]" bullets and their nested "  - @scope/pkg@version" lines. */
export function stripUpdatedDependencies(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^-\s+Updated dependencies\b/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s{2,}-\s/.test(line)) continue; // nested "  - @scope/pkg@version" continuation
    skipping = false;
    out.push(line);
  }
  return dropEmptyHeadings(out.join("\n"));
}

/**
 * Drop any "### ..." subsection heading that has nothing left under it (its bullets were entirely
 * "Updated dependencies" noise). Works block-by-block rather than one regex over the whole string:
 * a single regex relying on multiline `$` to mean "end of string" is a trap here, since `$` in
 * multiline mode also matches immediately before *any* newline — including the blank line that
 * ordinarily separates a heading from its own (non-empty) bullets — which silently strips headings
 * that still have real content below them.
 */
function dropEmptyHeadings(text: string): string {
  const blocks = text.split(/(?=^### )/m).filter((block) => block.length > 0);
  const kept = blocks.filter((block) => block.replace(/^### .*\n?/, "").trim().length > 0);
  return kept.join("\n").trim();
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Changesets always prepends new releases at the top of CHANGELOG.md, so file order is
 * reverse-chronological — but a one-time version reset (the drej -> alineo rename) means version
 * numbers aren't monotonically decreasing all the way down. Walk from the top and stop as soon as a
 * version isn't strictly less than the one before it, which lands exactly on that reset boundary
 * without needing a hardcoded version number or marker string.
 */
export function takeUntilRenameBoundary<T extends { version: string }>(sections: T[]): T[] {
  const kept: T[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (i > 0 && cmpSemver(sections[i].version, sections[i - 1].version) >= 0) break;
    kept.push(sections[i]);
  }
  return kept;
}

export async function getChangelogEntries(): Promise<ChangelogEntry[]> {
  const entries: ChangelogEntry[] = [];
  for (const source of SOURCES) {
    const [raw, dates] = await Promise.all([
      readFile(path.join(REPO_ROOT, source.changelogPath), "utf-8"),
      getPublishDates(source.npmName),
    ]);
    const sections = takeUntilRenameBoundary(parseSections(raw));
    for (const section of sections) {
      const body = stripUpdatedDependencies(section.body);
      if (!body) continue; // section was 100% "Updated dependencies" noise — nothing left to show
      entries.push({
        package: source.package,
        version: section.version,
        date: dates[section.version] ?? null,
        body,
      });
    }
  }
  // newest first; entries without a resolved date (shouldn't happen for published versions) sort last
  return entries.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}
