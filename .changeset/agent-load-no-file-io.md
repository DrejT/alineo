---
"alineo": minor
---

**Breaking:** `Alineo.load()` no longer does its own file I/O — see
[#184](https://github.com/DrejT/alineo/issues/184).

`load()`'s first argument is now the spec object itself, not a file path. `specPath` was read
exactly once and never touched again — coupling the SDK to `Bun.file()` and the local filesystem
for something that has nothing to do with what `load()` actually does (spin up a sandbox, install
Pi, run setup, checkpoint). Anyone who already had the spec — fetched over HTTP, pulled from a
database, generated programmatically — previously had to write a temp file just to call it.

```diff
-const agent = await Alineo.load("./agents/my-agent.json", { adapter });
+const spec = await Bun.file("./agents/my-agent.json").json();
+const agent = await Alineo.load(spec, { adapter });
```

The spec is still validated internally regardless (via `validateAgentSpec()`) — a raw
`JSON.parse()`'d object works fine, you don't need to call `validateAgentSpec()` yourself first
unless you want validation errors to surface before any sandbox/network work starts.

`Alineo.resume()` keeps accepting a bare path (`opts.specPath`) since it has a genuine
filesystem-coupled fallback `load()` doesn't: when neither `opts.spec` nor `opts.specPath` is
set, it queries the ledger for the sandbox's name and reads `./agents/<name>.json`. It also gains
`opts.spec` for the same no-I/O path as `load()`:

```ts
const agent = await Alineo.resume(savedSandboxId, { adapter, spec }); // no file read at all
```

`Alineo.spawn()`/`alineo fork` are unaffected — out of scope for this change (they still take a
child spec path, per issue #184's own scope note).

Surveyed via DeepWiki against crewAI (Pydantic — separate file-path and object entry points),
Flue (Valibot — `parseFlueConfig(value: unknown)` decoupled from `loadFlueConfig(path)`), and
vercel/eve (Zod — `compileAgentConfig(..., { definition?: unknown })`) while researching this:
every comparable spec-loading system keeps the validator I/O-free and splits the path-based
convenience wrapper out separately, rather than unioning `path | object` into one signature. This
change follows the same shape.
