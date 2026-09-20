# @alineo-labs/logger

Tiny, dependency-free logger for alineo. **Silent by default**, one switch to turn it on, child
loggers for context. Used by the alineo libraries and daemons so nothing prints unless you ask.

```bash
bun add @alineo-labs/logger
```

## For library code

```ts
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("agent"); // safe at module load; silent until logging is on
log.info("sandbox ready", { elapsed: "1.2s", sandboxId });
const runLog = log.child({ runId, agentId }); // every record carries these
if (log.isEnabled("debug")) log.debug("state", expensiveSnapshot());
```

Libraries never call `console.*` and never install a logger.

## For apps and scripts

```ts
import { installLoggerFromEnv } from "@alineo-labs/logger";
installLoggerFromEnv({ defaultLevel: "info" }); // daemon/CLI entrypoint: info unless the env says otherwise
```

Or with no code at all:

```bash
ALINEO_LOG_LEVEL=info bun my-script.ts
ALINEO_LOG=agent=debug,alineod=info bun apps/alineod/server.ts
```

| Variable            | Meaning                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ALINEO_LOG_LEVEL`  | Default level: `debug` \| `info` \| `warn` \| `error` \| `silent`                                                                |
| `ALINEO_LOG`        | Per-component levels, e.g. `agent=debug,alineod=info` (a bare level or `*=level` sets the default; wins over `ALINEO_LOG_LEVEL`) |
| `ALINEO_LOG_FORMAT` | `pretty` \| `json` — default: `pretty` on a terminal, `json` otherwise                                                           |
| `ALINEO_LOG_FILE`   | Write to this file instead of stderr                                                                                             |

Output goes to **stderr**, never stdout.

## Bring your own backend

`installLogger({ sink })` takes a `(record) => void`. Pino, for example:

```ts
import pino from "pino";
import { installLogger } from "@alineo-labs/logger";

const p = pino();
installLogger({
  level: "debug",
  sink: (r) => p[r.level]({ component: r.component, ...r.fields }, r.msg),
});
```

Configuration lives on `globalThis`, so several copies of this package in one process share a
single switch.

## Legacy exports

`ILogger`, `LogLevel`, `ConsoleLogger` and `noopLogger` (previously in `@alineo-labs/core`) are
still exported. Prefer `getLogger()`.
