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
// Seven checks live here today:
//
//   1. CLI       — every registered command name is a VERB, or an allowlisted noun.
//   2. Strings   — every command quoted in help, error, guidance or doc text resolves to a
//                  registered command. This is the one that would have caught `alineo ps`,
//                  a command that never existed but that `sessions-data.ts` documented
//                  itself as belonging to for months.
//   3. MCP tools — every tool is `{subject}_{verb}`, or a bare `{verb}` when it has no
//                  subject (`init`, exactly as on the CLI).
//   4. HTTP      — every path segment after a resource id is a VERB or a SUBJECT.
//   5. Events     — every event name the codebase still emits resolves to a definition in
//                  @alineo-labs/schema, via the rename table where it has an old name. This
//                  is the drift guard: an event added to one of the three legacy
//                  vocabularies without a definition fails here rather than silently
//                  existing outside the schema.
//   6. Durability — alineod's hardcoded PERSISTED_HARNESS_EVENTS set agrees with the
//                  `durable` flags on those events' definitions. The set is what decides
//                  today; the definitions are what will decide once alineod reads them
//                  instead. They have to be the same list on the day that swap happens, or
//                  the swap quietly changes which events earn a ledger row.
//   7. Specs      — every agent spec validates, including the ones a setup step writes as an
//                  escaped JSON string inside a shell command. Those are invisible to a
//                  rename pass and to a diff, and three of them still said `cli` after the
//                  field became `harness` — failing minutes into a run, inside the sandbox.
//
// Checks 3 and 4 read the source rather than importing it: a name check is a check on
// syntax, and a lint script has no business booting an MCP server or an HTTP app to ask
// what it called things. Each one also asserts that the number of names it extracted
// matches the number of registrations in the file — so a tool or route registered under a
// computed name makes the count diverge and fails the check instead of slipping past it.

const MCP_SERVER = "packages/mcp/src/server.ts";

/**
 * The places an event name is still declared outside `@alineo-labs/schema`, and how to read
 * each one. They stay for now — definitions are added beside them rather than replacing them,
 * so that the rename and the storage migration can land separately.
 *
 * alineod's own union is no longer one of them: `apps/alineod/src/schema.ts` now derives it
 * from the definitions, so it cannot drift and has nothing to check.
 */
const EVENT_VOCABULARIES: {
  file: string;
  pattern: RegExp;
  what: string;
  /** Narrows the search to one declaration in a file that holds several. */
  scope?: RegExp;
}[] = [
  {
    file: "packages/core/src/ledger.ts",
    // `SandboxCreated = "sandbox_created",` — but only inside `enum LedgerEvent`. The same
    // file also declares `enum SandboxStatus`, whose members are states, not events.
    scope: /enum LedgerEvent \{[\s\S]*?\n\}/,
    // Dotted now that the enum carries namespaced values; the old flat spelling still
    // matches, so this keeps working whichever side of the rename a checkout is on.
    pattern: /^\s*[A-Z]\w*\s*=\s*"([a-z][a-z_.]*)",/gm,
    what: "the SDK ledger enum",
  },
  {
    file: "packages/agent/src/types.ts",
    // `| { type: "tool_start"; … }` in the AgentEvent union. Still the harness's own flat
    // names: alineod translates them at its boundary, and renaming `AgentEvent` itself is a
    // change to the SDK's public streaming API rather than to what it stores.
    pattern: /\btype:\s*"([a-z][a-z_.]*)"/g,
    what: "the harness AgentEvent union",
  },
];

/**
 * Names that appear in one of those files but are not ledger events.
 *
 * `assistant`, `tool` and `user` are transcript *entry kinds* from
 * `GET /agents/:id/transcript`, which happen to live in the same schema file. They describe a
 * message's author, not something that happened.
 */
const NOT_EVENTS = new Set(["assistant", "tool", "user"]);

const ALINEOD_EMIT = "apps/alineod/src/engine/emit.ts";

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

import {
  AgentSpecSchema,
  allEvents,
  getEvent,
  isSubject,
  isVerb,
  parseName,
  renamedEventType,
  SUBJECTS,
  VERBS,
} from "@alineo-labs/schema";
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

const files = (
  await new Response(
    Bun.spawn([
      "git",
      "ls-files",
      "-z",
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.mjs",
      "*.md",
      "*.mdx",
      "*.json",
      "*.txt",
    ]).stdout,
  ).text()
)
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
const routeFiles = [...new Bun.Glob("*.ts").scanSync({ cwd: ALINEOD_ROUTES_DIR })].sort();

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

// ------------------------------------------------------------------ check 5: event names

let eventNamesSeen = 0;
for (const { file, pattern, what, scope } of EVENT_VOCABULARIES) {
  const whole = await Bun.file(file).text();
  const source = scope ? (scope.exec(whole)?.[0] ?? "") : whole;
  if (scope && source === "") {
    failures.push(`${file}: could not find the ${what} declaration — has it been renamed?`);
    continue;
  }
  pattern.lastIndex = 0;
  const names = [...source.matchAll(pattern)].map((m) => m[1]!);

  if (names.length === 0) {
    failures.push(
      `${file}: no event names found for ${what} — has it moved? An event check that reads ` +
        `nothing always passes.`,
    );
    continue;
  }
  eventNamesSeen += names.length;

  for (const name of new Set(names)) {
    if (NOT_EVENTS.has(name)) continue;
    // `run_started` meant a workflow run in one file and a swarm run in another, so the
    // rename table deliberately does not map it; each file resolves it from its own context.
    const renamed =
      name === "run_started"
        ? file.includes("alineod")
          ? "run.started"
          : "workflow.started"
        : renamedEventType(name);
    const type = renamed ?? name;
    if (getEvent(type)) continue;
    failures.push(
      `${file}: "${name}" (${what}) has no definition in @alineo-labs/schema.\n` +
        `    Either add one in packages/schema/src/events/, or map it in ` +
        `packages/schema/src/renames.ts if it is an old spelling of an event that exists.`,
    );
  }
}

// -------------------------------------------------------- check 6: durability agreement

{
  const source = await Bun.file(ALINEOD_EMIT).text();
  const block = /const PERSISTED_HARNESS_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!block) {
    failures.push(
      `${ALINEOD_EMIT}: could not find PERSISTED_HARNESS_EVENTS — if it has been replaced by ` +
        `the definitions' own \`durable\` flags, delete this check along with it.`,
    );
  } else {
    const persisted = [...block[1]!.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]!);
    for (const name of persisted) {
      const definition = getEvent(renamedEventType(name) ?? name);
      if (!definition) continue; // check 5 already reports this
      if (!definition.durable) {
        failures.push(
          `${ALINEOD_EMIT}: "${name}" is in PERSISTED_HARNESS_EVENTS, but ` +
            `${definition.type} is defined as durable: false. One of the two is wrong.`,
        );
      }
    }
    // And the other direction: a harness event defined as durable that alineod does not
    // persist would start earning rows the day alineod reads the definitions.
    const persistedTypes = new Set(persisted.map((n) => renamedEventType(n) ?? n));
    const harnessSubjects = new Set([
      "session",
      "turn",
      "tool",
      "message",
      "compaction",
      "retry",
      "queue",
      "extension",
      "permission",
    ]);
    for (const definition of allEvents()) {
      if (!harnessSubjects.has(definition.type.split(".")[0]!)) continue;
      if (!definition.durable || persistedTypes.has(definition.type)) continue;
      failures.push(
        `${definition.type} is defined as durable: true, but is not in ` +
          `${ALINEOD_EMIT}'s PERSISTED_HARNESS_EVENTS. It would start earning ledger rows ` +
          `the day alineod reads the definitions instead of the set.`,
      );
    }
  }
}

// ------------------------------------------------ check 7: agent specs, including the ones
//                                                   a setup step writes as an escaped string

/**
 * A spec file's own fields are checked the moment anything loads it. The ones that slip
 * through are the specs a **setup step writes**: a `printf` emitting a child spec as an
 * escaped JSON string is an opaque `run` command to every rename pass, to a reviewer reading
 * a diff, and to the JSON reader above. Three of them still said `"cli"` long after the field
 * became `harness`, while their own top level said `harness` — and they fail *inside the
 * sandbox*, several minutes into a run, as "invalid agent spec", which reads like the spec
 * being written is wrong rather than the example that wrote it.
 *
 * So: parse every JSON object embedded in a setup step's shell command, and hold it to the
 * same schema as a spec that lives in its own file.
 */

/** `printf` conversions stand in for values this check cannot know. A placeholder keeps the
 *  surrounding JSON parseable without pretending to validate what gets substituted. */
function stripPrintfConversions(run: string): string {
  return run.replace(/%%/g, "%").replace(/%[-+ #0]*[\d.]*[sdifu]/g, "PLACEHOLDER");
}

/** Every balanced `{…}` region that starts a JSON object, in source order. */
function embeddedObjects(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" || !/^\{\s*"/.test(text.slice(i, i + 8))) continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        found.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return found;
}

/** Tight on purpose: `name` plus a harness field is what an agent spec looks like and what
 *  nothing else in this repo looks like, so this never argues with a package.json. */
function looksLikeAgentSpec(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.name === "string" && ("harness" in o || "cli" in o);
}

function reportSpec(where: string, spec: Record<string, unknown>): void {
  const result = AgentSpecSchema.safeParse(spec);
  if (result.success) return;
  const stale = SPEC_FIELD_RENAMES.filter(([from, to]) => from in spec && !(to in spec));
  failures.push(
    `${where}: agent spec "${String(spec.name)}" does not validate against AgentSpecSchema.\n` +
      result.error.issues
        .map((i) => `    ${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("\n") +
      (stale.length > 0
        ? `\n    It still uses ${stale.map(([f]) => `"${f}"`).join(" and ")} — renamed to ` +
          `${stale.map(([, t]) => `"${t}"`).join(" and ")}.`
        : ""),
  );
}

/** Mirrors `packages/agent/src/schema.ts`'s own list; kept here so the message can name the
 *  rename rather than only reporting the missing field. */
const SPEC_FIELD_RENAMES: [string, string][] = [
  ["cli", "harness"],
  ["cliVersion", "harnessVersion"],
];

{
  // Self-test: the extractor has to survive the escaping a `printf` actually produces, or
  // this check reads nothing and passes forever.
  const fixture = `mkdir -p agents && printf '{"name":"w","cli":"pi","env":{"K":"%s"}}' "$K" > agents/w.json`;
  const extracted = embeddedObjects(stripPrintfConversions(fixture));
  if (extracted.length !== 1 || !looksLikeAgentSpec(JSON.parse(extracted[0]!))) {
    failures.push(
      `scripts/check-vocabulary.ts: the embedded-spec extractor no longer finds the spec in ` +
        `a \`printf\` setup step. Check 7 is reading nothing.`,
    );
  }
}

let specsSeen = 0;
for (const file of files.filter((f) => f.endsWith(".json"))) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(file).text());
  } catch {
    continue; // not our problem; a malformed JSON file fails elsewhere
  }
  if (!looksLikeAgentSpec(parsed)) continue;
  specsSeen++;
  reportSpec(file, parsed);

  const setup = (parsed as { setup?: unknown }).setup;
  if (!Array.isArray(setup)) continue;
  for (const [index, step] of setup.entries()) {
    const run = (step as { run?: unknown }).run;
    if (typeof run !== "string") continue;
    for (const candidate of embeddedObjects(stripPrintfConversions(run))) {
      let embedded: unknown;
      try {
        embedded = JSON.parse(candidate);
      } catch {
        continue; // a brace-balanced fragment that is not JSON — a shell expansion, say
      }
      if (!looksLikeAgentSpec(embedded)) continue;
      specsSeen++;
      reportSpec(`${file}: setup[${index}] (${(step as { name?: string }).name ?? "?"})`, embedded);
    }
  }
}

if (specsSeen === 0) {
  failures.push(
    `no agent specs found in ${files.length} tracked files — have the examples moved? ` +
      `A spec check that reads nothing always passes.`,
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
    `${routesSeen} alineod routes, ${eventNamesSeen} event names, ${specsSeen} agent specs ` +
    `and ${files.length} files check out.`,
);
