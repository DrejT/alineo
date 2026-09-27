# @alineo-labs/ledger

Behaviour for alineo's event ledger: sinks, fold helpers, and an in-memory store. The shapes
live in [`@alineo-labs/schema`](../schema); this package is what _does_ something with them.

```bash
bun add @alineo-labs/ledger
```

## Sinks

A sink is where an event goes on its way out — OpenTelemetry, a warehouse, a file.

```ts
import { composeSinks, jsonlSink, memorySink } from "@alineo-labs/ledger";

const captured = memorySink();
const sink = composeSinks([captured, jsonlSink((line) => stream.write(line))]);
```

**A sink is synchronous and must not throw.** Both constraints come from where sinks sit: on
the write path of a sandbox operation. An async sink invites a caller to await it, and a slow
export becomes sandbox backpressure. A throwing sink fails the operation that emitted the
event — exactly backwards, since an export failing should never stop the work being exported.

`composeSinks` isolates each sink, so one broken exporter cannot break its siblings or the
operation that triggered them. A sink that genuinely needs IO buffers internally and flushes
on its own schedule.

## Storage

`LedgerStorage` is the narrow append/read surface a durable store offers — three methods, not
fourteen. `MemoryStorage` implements it for tests. The real sqlite and postgres engines land
behind the same interface later.

The store assigns `seq`, because it is the only thing that can: a monotone sequence needs a
single writer for an aggregate.

## Fold

```ts
import { fold, inLedgerOrder, persistedOnly } from "@alineo-labs/ledger";
```

Replay helpers for the fold-equivalence gate — rebuild a projection from a sink's captured
stream and deep-equal it against the one rebuilt from the store's rows. If dual-write ever
drifts, that comparison is where it surfaces.
