# `@alineo-labs/config-shared`

**Internal only. Never published.** How every alineo setting is found, merged, validated and
frozen.

Consumed as a `workspace:*` dependency and **bundled into each consumer's dist at build time**,
the same way `@alineo-labs/cli-shared` is. Nothing resolves `@alineo-labs/config-shared` at
runtime.

## The one rule

> **No module-level mutable state.** `loadConfig()` is a pure function that returns a frozen
> object, and the caller keeps it. There is no `installConfig()` and no `getConfig()` singleton.

This is not a style preference, it is what makes the package safe to bundle. Because each
consumer bundles its own copy, a singleton here would mean `alineo` and `alineo-cli` each having
a *different* registry inside one process, drifting apart silently. `@alineo-labs/logger` has
exactly that kind of state, which is why it is published and listed in every consumer's
`neverBundle` instead.

Callers that want caching do it themselves — see `resolveProjectConfig()` in `packages/agent`,
which keeps one resolved config per working directory.

## Precedence

Lowest to highest:

```
schema defaults
  < ~/.config/alineo/config.json      user
  < alineo.config.json                project — found by bounded walk-up
  < ALINEO_CONFIG_CONTENT             inline JSON
  < ALINEO_* env vars                 ops
  < overrides                         flags, or an explicit object
```

Everything is validated once and then deep-frozen. Passing `discover: false` skips every file
and environment source and validates `overrides` alone — that is how a server, an embedded
caller or a test gets a config with no ambient input.

### The walk-up is bounded

`findProjectConfig()` climbs from the working directory, but stops after examining a directory
that contains `.git`, the user's home directory, or the filesystem root. Without a bound, an
unrelated `alineo.config.json` several levels up could silently configure a run.

### `null` means "not set"

`alineo.config.json` is hand-editable, and an interrupted write can leave
`{"defaults": {"resources": null}}` behind. No field has a meaningful null value, so nulls are
dropped before validation and the built-in default applies — matching the `??` chain this
replaced, rather than failing validation and taking the daemon down.

## Usage

```ts
import { loadProjectConfig } from "@alineo-labs/config-shared";

const config = loadProjectConfig();            // discover everything
const pinned = loadProjectConfig({             // no ambient input
  discover: false,
  overrides: { serverUrl: "http://127.0.0.1:8080" },
});
```

Settings belonging to one consumer stay with that consumer and use the primitives directly.
`apps/alineod/config.ts` declares its own environment variables this way:

```ts
import { defineEnv, readEnvGroup } from "@alineo-labs/config-shared";
import { z } from "zod";

export const ENV_VARS = {
  PORT: defineEnv({
    name: "ALINEOD_PORT",
    description: "HTTP + SSE listen port.",
    schema: z.coerce.number().int().positive().max(65535),
    default: 4600,
  }),
};

const env = readEnvGroup(ENV_VARS, { onWarning: (m) => warnings.push(m) });
```

Declaring variables rather than reading `process.env` inline is what makes the set knowable:
`envTable()` generates the docs table from the same declarations the code reads, `aliases` keeps
an old name working through a rename, and a bad value is rejected with its name and value
(`ALINEOD_PORT="abc" is not valid: ...`) instead of becoming `NaN` and starting anyway.

Warnings are returned through an `onWarning` callback rather than logged, so this package stays
free of side effects and of a dependency on the logger.

## Credentials

API keys are never stored in config files. Specs reference them by name (`${NVIDIA_API_KEY}`)
and they are resolved from the environment of the process that spawns the agent.

## External consumers

Because nothing is published, `ProjectConfig` cannot be imported outside the repo.
`projectConfigJsonSchema()` emits the schema instead, so an `alineo.config.json` with a
`$schema` key gets autocomplete and validation in any editor with nothing installed.
