#!/usr/bin/env bun
// Usage: bun scripts/check-vocabulary.ts
//
// Fails the build when a surface invents vocabulary.
//
// One person meets the CLI, the SDK, the daemon's HTTP API, the MCP tools and the event
// stream, and each of those was free to pick its own spelling. That is how `spawn` came to
// mean "create a root agent" in the CLI and "create a child" in the SDK. The words every
// surface is allowed to use are data in `@alineo-labs/schema`; this script is what makes
// them fail-able, so a new component inherits the language by not building without it.
//
// Four checks live here today:
//
//   1. CLI       — every registered command name is a VERB, or an allowlisted noun.
//   2. Strings   — every command quoted in help, error, guidance or doc text resolves to a
//                  registered command. This is the one that would have caught `alineo ps`,
//                  a command that never existed but that `sessions-data.ts` documented
//                  itself as belonging to for months.
//   3. MCP tools — every tool is `{subject}_{verb}`, or a bare `{verb}` when it has no
//                  subject (`init`, exactly as on the CLI).
//   4. HTTP      — every path segment after a resource id is a VERB or a SUBJECT.
//
// Checks 3 and 4 read the source rather than importing it: a name check is a check on
// syntax, and a lint script has no business booting an MCP server or an HTTP app to ask
// what it called things. Each one also asserts that the number of names it extracted
// matches the number of registrations in the file — so a tool or route registered under a
// computed name makes the count diverge and fails the check instead of slipping past it.

const MCP_SERVER = "packages/mcp/src/server.ts";

/**
 * Globbed rather than listed, so a new route file is checked the day it is added instead of
 * the day someone remembers to name it here. Not every file in the directory registers a
 * route — `sse.ts` and `http.ts` are helpers — so the floor below is on the directory's
 * total, not on each file.
 */
const ALINEOD_ROUTES_DIR = "apps/alineod/src/routes";

/**
 * Route segments that are neither a VERB nor a SUBJECT, each with the reason it stays.
 *
 * One entry, and it is a real tension rather than an oversight: `notify-on` mirrors the
 * `notifyOn` spawn-option field, so the route and the field agree with each other while
 * disagreeing with the verb list. Reconciling the pair is alineod's own wire change, not a
 * rename — see the ledger work.
 */
const ROUTE_SEGMENT_ALLOWLIST = new Map([["notify-on", "mirrors the `notifyOn` spawn option"]]);
//
// Check 2 matters more than it looks. `packages/cli/pi-extension/alineo.ts` injects command
// syntax into a running agent's system prompt: a stale string there does not fail a build,
// it fails a *model*, later, as a confused agent emitting commands that no longer exist.

import { SUBJECTS, VERBS, isSubject, isVerb, parseName } from "@alineo-labs/schema";
import { commands } from "../packages/cli/src/commands/registry.ts";

/**
 * Command names that are nouns rather than verbs, each because it names a *view* of
 * something rather than an action on it. Kept short on purpose — a noun command is a small
 * exception, and a long list of them means the vocabulary has stopped being a vocabulary.
 */
const NOUN_COMMANDS = new Set([
  "agents", // a listing; `agent_list` would be the tool-shaped spelling
  "logs", // a listing
  "telemetry", // a settings group: `telemetry status|enable|disable`
]);

/**
 * A retired command name is written in bold prose (**alineo fork**), never in a code span, so
 * that a reader — or a model — skimming for something to run never finds a dead command
 * formatted as if it were live. That convention is why naming-history notes pass this check
 * without needing an entry below.
 *
 * Words that follow "alineo" in prose without being an invocation — the product name plus a
 * noun ("alineo docs", "alineo is"), not a command line. Every entry needs a reason; if one
 * of these ever becomes a real command, delete the entry rather than leaving both.
 */
const NOT_INVOCATIONS = new Set([
  "blog", // "alineo blog" — the site section
  "browser-stream", // a log prefix in packages/agent-browser
  "config", // "alineo config" — a label for alineo.config.json
  "docs", // "alineo docs" — the site, and the docs MCP server's name
  "error", // `console.error("alineo error:", …)` in docs examples
  "factory", // a test describe() block
  "project", // "alineo project config" — a JSON Schema title
  "repo", // link text
  "sandbox", // "alineo sandbox API" — link text
  "run", // historical: the command `alineo spawn` replaced, quoted as history in RUBRIC.md
  "runs", // "alineo runs sandboxes against…" — prose
  "is", // prose
  "ships", // prose
]);

/**
 * Not scanned for command strings.
 *
 * Changelogs and the changesets that become them are the record of what shipped *then*.
 * A release note announcing a rename has to name what it renamed; rewriting it to today's
 * spelling would make the history lie about what that release actually exposed.
 *
 * This file is skipped because it is the one place a retired name is data rather than
 * documentation — the fixtures below prove the patterns still catch `alineo kill` and
 * `alineo ps`, which means it must be allowed to contain them.
 */
const SKIP = [
  /(^|\/)CHANGELOG\.md$/,
  /^\.changeset\//,
  /^scripts\/check-vocabulary\.ts$/,
  /^plans\//,
  /^research\//,
];

const registered = new Set(commands.map((c) => c.name));

const failures: string[] = [];

// ---------------------------------------------------------------- check 1: CLI commands

for (const command of commands) {
  if (!isVerb(command.name) && !NOUN_COMMANDS.has(command.name)) {
    failures.push(
      `packages/cli/src/commands/registry.ts: command "${command.name}" is neither a VERB ` +
        `from @alineo-labs/schema nor an allowlisted noun.\n` +
        `    Verbs: ${VERBS.join(" ")}\n` +
        `    Allowlisted nouns: ${[...NOUN_COMMANDS].join(" ")}`,
    );
  }
  // Each variant's usage line has to start with the command it documents, or the generated
  // help text says one thing and dispatch does another.
  for (const variant of command.variants) {
    if (!variant.usage.startsWith(`alineo ${command.name}`)) {
      failures.push(
        `packages/cli/src/commands/registry.ts: usage "${variant.usage}" does not start with ` +
          `"alineo ${command.name}".`,
      );
    }
  }
}

// ------------------------------------------------------------- check 2: quoted commands

// An invocation, as opposed to the product name followed by a noun, looks like one of:
//   - a code span:            `alineo spawn <parent> …`
//   - a quoted string:        "Usage: alineo stop <sandbox-id>"  /  'alineo agents'
//   - a command line:         a line whose first non-blank text is `alineo …`, optionally
//                             after a `$ ` or `bunx `/`npx ` prefix
//
// The docs mostly invoke the binary as `bunx alineo-cli <verb>`, so the package-name form
// has to be matched too — it was the larger half of the surface when this check was first
// run. Plain "alineo" needs whitespace after it (`\s`) precisely so that `alineo-cli`
// doesn't match through the generic rule and get read as the word "cli".
const PATTERNS = [
  /[`'"](?:bunx |npx )?alineo(?:-cli)?[ \t]+([a-z][a-z-]*)/g,
  /^[ \t>]*\$?[ \t]*(?:bunx |npx )?alineo(?:-cli)?[ \t]+([a-z][a-z-]*)/gm,
  // The shape a thrown usage or hint message takes, where the command sits mid-string and
  // so has no delimiter in front of it: `throw new Error("Usage: alineo stop <id>")`. The
  // imperative lead-in is what marks it as an instruction rather than prose — a bare word
  // match here would read every "alineo is…" sentence as a command.
  /\b(?:[Uu]sage|[Rr]un|[Tt]ry):?[ \t]+['"`]?(?:bunx |npx )?alineo(?:-cli)?[ \t]+([a-z][a-z-]*)/g,
];

/**
 * `spawn` did not disappear in the CLI rename — it changed meaning, from "start a root
 * agent from a spec" to "spawn a child from a running session". So a stale
 * `alineo spawn ./agents/foo.json` still names a real command and passes the check above,
 * while doing something entirely different from what the text promises. Its first argument
 * is now a parent session name, so a spec path sitting there is the tell.
 */
const SPEC_PATH_AFTER_SPAWN = /(?:bunx |npx )?alineo(?:-cli)? spawn\s+[^\s`'"]*\.json/g;

// ------------------------------------------------------- check 0: the checks still bite
//
// A check that silently stops matching is worse than no check, because it reads as a
// passing guarantee. Before scanning anything, prove the patterns still catch strings we
// know are wrong — so that loosening a regex to make a real failure go away fails here
// instead.

const MUST_MATCH: [string, RegExp][] = [
  ["`alineo kill <id>`", PATTERNS[0]!],
  ['"Usage: alineo ps"', PATTERNS[2]!],
  ["Run alineo ps to list them", PATTERNS[2]!],
  ["  bunx alineo-cli fork a b", PATTERNS[1]!],
  ["    $ alineo fork a b", PATTERNS[1]!],
  ["`alineo spawn ./agents/worker.json`", SPEC_PATH_AFTER_SPAWN],
];

for (const [sample, pattern] of MUST_MATCH) {
  pattern.lastIndex = 0;
  if (!pattern.test(sample)) {
    failures.push(
      `scripts/check-vocabulary.ts: the pattern ${pattern} no longer matches ${JSON.stringify(sample)}. ` +
        `It has been loosened past the thing it exists to catch.`,
    );
  }
  pattern.lastIndex = 0;
}

// And prove it does not fire on the product name followed by a noun, which is the whole
// reason the patterns are shaped the way they are rather than a bare word match.
for (const sample of ["alineo is an agent platform", "the alineo repo", "`alineo-cli` on npm"]) {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(sample);
    pattern.lastIndex = 0;
    if (match && !NOT_INVOCATIONS.has(match[1]!) && !registered.has(match[1]!)) {
      failures.push(
        `scripts/check-vocabulary.ts: ${pattern} now reads ${JSON.stringify(sample)} as an ` +
          `invocation of "${match[1]}". It has been tightened into false positives.`,
      );
    }
  }
}

const files = (await new Response(Bun.spawn(["git", "ls-files", "-z", "--",
  "*.ts", "*.tsx", "*.js", "*.mjs", "*.md", "*.mdx", "*.json", "*.txt"]).stdout).text())
  .split("\0")
  .filter((f) => f.length > 0 && !SKIP.some((re) => re.test(f)));

for (const file of files) {
  const text = await Bun.file(file).text();

  SPEC_PATH_AFTER_SPAWN.lastIndex = 0;
  let stale: RegExpExecArray | null;
  while ((stale = SPEC_PATH_AFTER_SPAWN.exec(text)) !== null) {
    const line = text.slice(0, stale.index).split("\n").length;
    failures.push(
      `${file}:${line}: "${stale[0]}" passes a spec path to \`alineo spawn\`, whose first ` +
        `argument is a parent session name.\n` +
        `    This reads like the pre-rename \`spawn\`, which is now \`alineo start <spec>\`.`,
    );
  }

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const word = match[1]!;
      if (registered.has(word) || NOT_INVOCATIONS.has(word)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(
        `${file}:${line}: quotes "alineo ${word}", which is not a registered command.\n` +
          `    Commands: ${[...registered].join(" ")}\n` +
          `    If this is prose rather than an invocation, add "${word}" to NOT_INVOCATIONS ` +
          `in scripts/check-vocabulary.ts with a reason.`,
      );
    }
  }
}

// ------------------------------------------------------------------- check 3: MCP tools

let mcpToolCount = 0;
{
  const source = await Bun.file(MCP_SERVER).text();
  const registrations = source.match(/\bregisterTool\(/g)?.length ?? 0;
  const names = [...source.matchAll(/\bregisterTool\(\s*"([^"]+)"/g)].map((m) => m[1]!);
  mcpToolCount = names.length;

  // A regex that matches nothing also reports no failures. Anchor both checks on a floor so
  // that a refactor which moves the registrations elsewhere fails loudly instead of quietly
  // turning the check into a no-op.
  if (registrations === 0) {
    failures.push(`${MCP_SERVER}: no registerTool() calls found — has the file moved?`);
  }

  if (names.length !== registrations) {
    failures.push(
      `${MCP_SERVER}: found ${registrations} registerTool() calls but only ${names.length} ` +
        `string-literal names. A tool registered under a computed name cannot be checked.`,
    );
  }

  for (const name of names) {
    // A tool with no subject is named for the verb alone — `init`, the same way the CLI
    // spells it. Anything else has to be {subject}_{verb}.
    if (isVerb(name) || parseName(name, "_")) continue;
    failures.push(
      `${MCP_SERVER}: tool "${name}" is not {subject}_{verb}, nor a bare verb.\n` +
        `    Subjects: ${SUBJECTS.join(" ")}\n` +
        `    Verbs: ${VERBS.join(" ")}`,
    );
  }
}

// ----------------------------------------------------------------- check 4: HTTP routes

let routesSeen = 0;
const routeFiles = [
  ...new Bun.Glob("*.ts").scanSync({ cwd: ALINEOD_ROUTES_DIR }),
].sort();

for (const name of routeFiles) {
  const file = `${ALINEOD_ROUTES_DIR}/${name}`;
  const source = await Bun.file(file).text();
  const registrations = source.match(/\.(get|post|put|patch|delete)\(/g)?.length ?? 0;
  const paths = [...source.matchAll(/\.(?:get|post|put|patch|delete)\(\s*"([^"]*)"/g)].map(
    (m) => m[1]!,
  );
  routesSeen += registrations;

  if (paths.length !== registrations) {
    failures.push(
      `${file}: found ${registrations} route registrations but only ${paths.length} ` +
        `string-literal paths. A route built from a computed path cannot be checked.`,
    );
  }

  for (const path of paths) {
    const segments = path.split("/").filter((s) => s.length > 0);
    // Everything up to and including the resource id is the resource itself; what follows is
    // where a surface invents vocabulary.
    const idAt = segments.findIndex((s) => s.startsWith(":"));
    if (idAt === -1) continue;
    for (const segment of segments.slice(idAt + 1)) {
      if (segment.startsWith(":")) continue;
      if (ROUTE_SEGMENT_ALLOWLIST.has(segment)) continue;
      // HTTP pluralizes a collection segment and nothing else does, so `/events` is the
      // `event` subject.
      const singular = segment.endsWith("s") ? segment.slice(0, -1) : segment;
      if (isVerb(segment) || isSubject(segment) || isSubject(singular)) continue;
      failures.push(
        `${file}: route "${path}" has segment "${segment}" after the resource id, which is ` +
          `neither a VERB nor a SUBJECT.\n` +
          `    Subjects: ${SUBJECTS.join(" ")}\n` +
          `    Verbs: ${VERBS.join(" ")}`,
      );
    }
  }
}

if (routesSeen === 0) {
  failures.push(
    `${ALINEOD_ROUTES_DIR}: no route registrations found in ${routeFiles.length} file(s) — ` +
      `has the routing layer moved? An HTTP check that reads nothing always passes.`,
  );
}

// ------------------------------------------------------------------------------ report

if (failures.length > 0) {
  console.error(`\nVocabulary check failed (${failures.length}):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

console.log(
  `vocabulary: ${commands.length} CLI commands, ${mcpToolCount} MCP tools, ` +
    `${routesSeen} alineod routes and ${files.length} files check out.`,
);
