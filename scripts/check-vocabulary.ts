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
// Two checks live here today:
//
//   1. CLI       — every registered command name is a VERB, or an allowlisted noun.
//   2. Strings   — every command quoted in help, error, guidance or doc text resolves to a
//                  registered command. This is the one that would have caught `alineo ps`,
//                  a command that never existed but that `sessions-data.ts` documented
//                  itself as belonging to for months.
//
// The MCP-tool and HTTP-route checks join them when those surfaces are renamed.
//
// Check 2 matters more than it looks. `packages/cli/pi-extension/alineo.ts` injects command
// syntax into a running agent's system prompt: a stale string there does not fail a build,
// it fails a *model*, later, as a confused agent emitting commands that no longer exist.

import { VERBS, isVerb } from "@alineo-labs/schema";
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
 * Changelogs are the record of what shipped *then*; rewriting an old entry to use today's
 * spelling would make the history lie about what that release actually exposed.
 */
const SKIP = [/(^|\/)CHANGELOG\.md$/, /^plans\//, /^research\//];

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

// ------------------------------------------------------------------------------ report

if (failures.length > 0) {
  console.error(`\nVocabulary check failed (${failures.length}):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

console.log(
  `vocabulary: ${commands.length} CLI commands and ${files.length} files check out.`,
);
