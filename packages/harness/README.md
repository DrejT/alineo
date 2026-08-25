# @alineo-labs/harness

A small, domain-agnostic primitive for building a structured system prompt out of named,
independently-addressable sections instead of hand-concatenated template strings gated by ad
hoc `if`s.

Private package — not published, no consumers in this repo yet. See "Provider-neutral by
design" below for the research behind why this primitive (role/context/guardrail/mindset/
format/examples sections, XML-tag rendering) is a reasonable general-purpose building block
rather than tied to any one model provider's conventions.

```ts
import { harness } from "@alineo-labs/harness";

const h = harness()
  .role("You are a careful code-review assistant.")
  .guardrail("Never execute code you have not read.")
  .context("The repository is a TypeScript monorepo using bun workspaces.")
  .examples("Input: ... Output: ...");

h.render();
// <role>
// You are a careful code-review assistant.
// </role>
//
// <guardrail>
// Never execute code you have not read.
// </guardrail>
//
// <context>
// The repository is a TypeScript monorepo using bun workspaces.
// </context>
//
// <examples>
// Input: ... Output: ...
// </examples>
```

## Core model

A `Harness` is an ordered collection of named sections, each an ordered list of raw-string
fragments. `.role(text)`, `.context(text)`, `.guardrail(text)`, `.mindset(text)`,
`.format(text)`, and `.examples(text)` are sugar over the general `.section(name, text)` —
custom section names work identically, just without a dedicated method. Calling the same
section again appends another fragment rather than replacing it. Section names must be legal
XML tag names (letters/digits/`._-`, not starting with a digit); `.section()` throws
otherwise, rather than letting `render()` produce silently-malformed output later.

There is no conditional logic inside `Harness` itself — it's a dumb accumulator, not a rules
engine. Whether a fragment gets added at all is entirely the caller's decision, made before
calling `.section()`.

- **`render(options?)`** — the final composed prompt string.
  - `{ format: "xml" }` (default) — each non-empty section wrapped in an XML tag matching
    its name; a section nobody wrote to is omitted entirely, not emitted as an empty tag
    pair. Fragment text is scanned for a close-tag-shaped sequence matching its own section
    (e.g. `</role>` inside a `.role()` fragment) and neutralizes it (`<\/role>`) so untrusted
    fragment content can never forge a section boundary.
  - `{ format: "markdown" }` — the same `## name` header shape `dumps()`/`log()` use.
    OpenAI's and Gemini's own docs treat this as a first-class equivalent to XML tags, not a
    fallback — see "Provider-neutral by design" below.
- **`log()`** — a `console.log`-for-a-harness debug view: shows the section→fragment
  structure (the same shape `dumps()` writes to disk / `render({ format: "markdown" })`
  returns), not the XML-tag-wrapped prompt.
- **`dumps(path)` / `load(path, options?)`** — always a markdown file, one `## name` header
  per non-empty section. `load(path)` **replaces** the harness's content entirely by default;
  pass `{ merge: true }` to add to existing content instead.
- **`.lock(name)` / `.isLocked(name)`** — opt-in write protection. After `.lock("guardrail")`,
  any further `.section("guardrail", ...)` call (directly or via `.merge()`) throws
  `SectionLockedError` instead of silently appending. Unlocked sections are unaffected;
  single-writer callers that never call `.lock()` see no behavior change.
- **`.clone()`** — an independent deep copy (sections, order, and locks), synchronous, no
  I/O. Writes to the clone never affect the original or vice versa.
- **`.merge(other, options?)`** — appends every section from `other` onto `this`, in `this`'s
  canonical order, respecting `this`'s locks. Throws `SectionLockedError` if `other` would
  write into a locked section on `this`, unless `{ overwriteLocked: true }` is passed. Does
  not mutate `other`.
- **`estimateTokens()`** — `Math.ceil(render().length / 4)`, the same chars-per-token rule of
  thumb quoted across providers' own docs for English text. Not a real tokenizer — for quick
  cost/budget visibility, not billing-accurate counts.

## Non-goals

This package has no awareness of agents, master/worker relationships, spawn depth, or RLM
orchestration — `.lock()`/`.clone()`/`.merge()` are generic primitives a caller can build
agent-aware policy on top of, not agent-aware themselves. There is also no automatic
token-budget enforcement (`estimateTokens()` reports size; truncating or rejecting an
over-budget harness is left to the caller) and no real tokenizer integration — the char/4
heuristic is deliberately zero-dependency.

## Provider-neutral by design

This package's original design comment cited Anthropic's own Claude prompting docs as the
reference for its section order (identity/context → constraints → format/examples). Before
considering the package for wider (OSS) use, we researched whether XML-tag-wrapped sections
and this ordering are a Claude-specific convention or broader practice, checking each
frontier lab's own official docs:

| Provider               | Delimiter guidance                                                                                       | Section taxonomy                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **OpenAI**             | XML tags _or_ Markdown headers — "pick one, be consistent"                                               | Identity → Instructions → Examples → Context (context pushed to the end for long inputs) |
| **Google (Gemini)**    | XML tags or `##` headers, explicitly interchangeable                                                     | Role/persona + constraints first, then task/context, then format                         |
| **Anthropic (Claude)** | XML tags, framed as general best practice, not Claude-specific                                           | instructions/example/context tags                                                        |
| **Mistral**            | "Markdown and/or XML-style tags are ideal... familiar to the model from training"                        | Similar ordering                                                                         |
| **Meta/Llama**         | Partial outlier — structure is baked into chat-template tokens; guidance stresses brevity over rich tags | —                                                                                        |
| **xAI**                | No systematic taxonomy doc published                                                                     | —                                                                                        |

**Finding:** the XML-tag + role→context→guardrail→mindset→format→examples taxonomy this
package uses is convergent industry consensus, not an Anthropic idiosyncrasy — OpenAI and
Mistral independently recommend the same delimiter style and near-identical ordering. No
provider's official docs advise against XML tags. Llama is the one soft outlier
(template-driven, brevity-biased).

This means the _builder itself_ (`packages/harness/src/index.ts`) is legitimately portable
— any vendor-specific coupling belongs in a future caller's own prompt content, not in this
package. (In `alineo`'s private/commercial fork, that caller is `packages/cli`'s
`harness-setup.ts`, which renders Pi-specific `.pi/SYSTEM.md` content — deliberately not
brought over here, since it's product-specific rather than a general-purpose primitive.)

**Closed gap:** OpenAI and Google treat Markdown-header rendering (`## Section`) as a
first-class equivalent to XML tags, not a fallback. This package already round-tripped
through that exact shape internally (`dumps()`/`load()`); `render({ format: "markdown" })`
now exposes it as an alternate `render()` mode alongside the XML default, so both conventions
its own research says providers treat as interchangeable are available from the same call.

Sources: [GPT-5 prompting guide (OpenAI Cookbook)](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide),
[Prompt engineering (OpenAI API docs)](https://developers.openai.com/api/docs/guides/prompt-engineering),
[Context Engineering – Session Memory (OpenAI Cookbook)](https://cookbook.openai.com/examples/agents_sdk/session_memory),
[Prompt design strategies (Gemini API docs)](https://ai.google.dev/gemini-api/docs/prompting-strategies),
[Prompting best practices (Claude Platform Docs)](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/use-xml-tags),
[Effective context engineering for AI agents (Anthropic)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Best Practices (Mistral Docs)](https://docs.mistral.ai/models/best-practices),
[Prompt engineering (Meta developer docs)](https://developer.meta.com/ai/docs/how-to-guides/prompting/),
[xAI grok-prompts repository](https://github.com/xai-org/grok-prompts).
