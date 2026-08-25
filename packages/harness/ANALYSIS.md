# `@alineo-labs/harness` — current-state analysis and improvement plan

Scope: `packages/harness` (the `Harness` prompt-builder primitive), not the broader `alineo`
sandbox/agent platform. This package is private, unpublished, and has no consumers in this
repo yet, so the analysis below is about hardening it _before_ `packages/cli`'s
`harness-setup.ts` (or any other future caller) starts depending on it — the moment it has one
real writer and one real reader is the moment its current gaps stop being free.

## 1. What exists today

`Harness` is a mutable builder: a `Map<string, string[]>` of named sections plus a
`customOrder` array for section names outside the built-in six
(`role/context/guardrail/mindset/format/examples`). Public surface:

- `.section(name, text)` / sugar methods — append a fragment, never replace.
- `.render()` — XML-tag-wrapped concatenation in canonical order.
- `.log()` — markdown-header debug view.
- `.dumps(path)` / `.load(path)` — markdown round-trip; `load` always replaces.

It deliberately has **no** conditional logic, no agent/spawn-depth awareness, no
access control, and no composition support (all called out as non-goals in the README).

## 2. Where it breaks under real load

| #   | Gap                                                                                                                          | Why it matters once there's a real caller                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No format choice** — `render()` only emits XML tags.                                                                       | README's own research shows OpenAI/Gemini treat `## header` Markdown as a first-class equivalent, not a fallback. A caller targeting a non-Claude model has no way to get that shape from `render()` today — only from the debug-only `log()`/`dumps()` path.                                   |
| 2   | **No injection guard** — a fragment's raw text is spliced straight between `<tag>`/`</tag>`.                                 | Any fragment sourced from untrusted input (tool output, user message, another agent's response) containing `</role>` or a stray `<guardrail>` corrupts the section boundary an LLM relies on to distinguish instructions from data — the exact failure mode XML-tagging is supposed to prevent. |
| 3   | **No write protection** — any caller can call `.section("guardrail", ...)` at any point.                                     | The README's own motivating use case (master/child agent spawning, RLM orchestration) implies multiple writers touching one harness. Nothing stops a child agent's contribution from silently appending to (or a bug from overwriting the intent of) a `guardrail`/`role` section a parent set. |
| 4   | **No composition** — building one harness from pieces of others requires manually re-calling `.section()` for each fragment. | Multi-agent fan-out (master builds a shared `context`+`guardrail` base, each child adds its own `role`) is exactly the scenario `.spawn()`/`.fork()` in `packages/agent` exist for, and there's no supported way to derive a child harness from a parent one.                                   |
| 5   | **No cost/size visibility** — nothing reports how large a rendered prompt is.                                                | Prompt size is the direct lever on token cost and latency; a harness with no way to ask "how big is this going to be" pushes every caller to reimplement rough `text.length / 4` estimation themselves, inconsistently.                                                                         |
| 6   | **No cheap branching** — the only way to get an independent copy is to replay `.section()` calls.                            | `load()` is destructive-only (replaces, never merges) and there's no `.clone()`, so exploring "try appending X, keep original if it's not good" or forking one harness per spawned child means manually re-deriving state.                                                                      |
| 7   | **`load()` is always destructive.**                                                                                          | Reasonable as the _only_ mode for a fresh harness, but the sole "add a template's contents onto what I already have" primitive is `.section()` calls one at a time — there's no one-shot "load this file additively."                                                                           |

None of these are correctness bugs against the current test suite — they're gaps that are
invisible with zero consumers and become load-bearing the moment a second one shows up.

## 3. Design principles for closing the gaps

Kept deliberately in scope with the package's existing philosophy — **stay a dumb
accumulator, not a rules engine** — every addition below is either (a) an alternate view over
the same section data, or (b) an explicit opt-in guard the caller enables, never implicit
policy the package imposes on every user.

- **Cost**: make prompt size a first-class, cheap-to-query property (`estimateTokens()`),
  so cost control is something a caller can build on top rather than reimplement.
- **Scalability** (multi-agent / multi-writer): `.clone()` for cheap branching per spawned
  child, `.merge()` for composing a child's harness back from a parent's, both O(sections)
  copies with no I/O.
- **Robustness**: escape section-breaking sequences in fragment text by default (opt-out,
  not opt-in — a security-relevant default should not require the caller to know to ask for
  it); validate section names are legal XML tag names up front instead of producing
  silently-malformed output.
- **Innovation / provider-neutrality**: `render({ format })` closes the exact gap the
  README's own cross-provider research already identified, rather than leaving `log()`'s
  markdown view as the only place that shape exists.
- **Non-breaking**: every change below is additive or defaults to today's exact behavior —
  `render()` with no args is byte-identical to before, `load()` with no options still
  replaces.

## 4. Improvement list (implemented in this branch)

1. **`render(options?)` with `format: "xml" | "markdown"`** (default `"xml"`, unchanged) —
   closes README's "Known gap" directly.
2. **Fragment-text escaping** — any `</name>` (case-insensitive, matching a currently-open
   section tag) inside fragment text is neutralized in XML output so a fragment can never
   forge a closing tag for a section it isn't. Applied by default in `render()`.
3. **Section-name validation** — `.section(name, text)` throws on empty/whitespace or names
   that aren't legal XML tag names, instead of silently producing broken `render()` output
   later.
4. **`.lock(name)` / write protection** — after `.lock("guardrail")`, further
   `.section("guardrail", ...)` calls throw instead of silently appending. Opt-in per
   section, so single-writer callers see zero behavior change.
5. **`.clone()`** — deep-copies sections/order/locks into a new independent `Harness`, O(n)
   in section count, no I/O. Built for the spawn-a-child-agent-from-a-shared-base case.
6. **`.merge(other, options?)`** — appends every section from `other` onto `this`
   (respecting lock checks), with an optional `{ overwriteLocked: false }` default so a
   locked section on the receiving harness can't be silently clobbered by a merge.
7. **`estimateTokens()`** — cheap `render()`-length-based heuristic (chars/4, the same rule
   of thumb every provider's own docs quote for English text) so callers get consistent cost
   visibility without reimplementing it themselves.
8. **`load(path, { merge: true })`** — opt-in additive load; default remains today's
   replace-everything behavior, so existing callers/tests see no change.

Each item has direct test coverage in `test/harness.test.ts` and is documented in `README.md`.

## 5. Explicitly deferred (still out of scope)

Kept out to preserve "dumb accumulator, not a rules engine":

- Any _automatic_ policy (auto-truncation on a token budget, auto-locking of built-in
  sections) — these are product decisions a caller should make explicitly, not defaults this
  package imposes.
- Real tokenizer integration (tiktoken/provider-specific) — the char/4 heuristic is
  deliberately zero-dependency; a precise-token mode belongs in a caller that already has a
  model choice, not in a provider-neutral primitive.
- Spawn-depth/RLM-aware section ownership — still explicitly the caller's job per the
  README's non-goals; `.lock()`/`.merge()` give callers the primitives to build that policy
  without the package needing to know what an "agent" is.
