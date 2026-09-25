import type { LedgerEnvelope } from "@alineo-labs/schema/types";

/**
 * Somewhere an event goes on its way out — OpenTelemetry, a warehouse, a file.
 *
 * **Synchronous, and it must not throw.** Both constraints come from where sinks sit: on the
 * write path of a sandbox operation. An async sink invites a caller to await it, and a slow
 * export would become sandbox backpressure. A throwing sink would fail the operation that
 * emitted the event, which is exactly backwards — an export failing should never stop the
 * work being exported.
 *
 * A sink that genuinely needs IO buffers internally and flushes on its own schedule.
 *
 * This is the same contract `composeHooks()` already established in
 * `@alineo-labs/core`'s `sandbox/hooks.ts`: one broken adapter cannot break its siblings or
 * the operation that triggered them.
 */
export type EventSink = (envelope: LedgerEnvelope) => void;

/**
 * Fan an event out to several sinks, isolating each.
 *
 * A throwing sink is reported through `onError` and the rest still run. `onError` itself is
 * guarded, because a reporting callback that throws would defeat the whole arrangement —
 * that is the failure this function exists to prevent, and it would be embarrassing to
 * reintroduce it one level up.
 */
export function composeSinks(
  sinks: readonly EventSink[],
  onError?: (error: unknown, envelope: LedgerEnvelope) => void,
): EventSink {
  return (envelope) => {
    for (const sink of sinks) {
      try {
        sink(envelope);
      } catch (error) {
        try {
          onError?.(error, envelope);
        } catch {
          // Nothing left to report to.
        }
      }
    }
  };
}

export interface MemorySink {
  (envelope: LedgerEnvelope): void;
  /** Everything captured, in emission order. */
  readonly events: readonly LedgerEnvelope[];
  clear(): void;
}

/**
 * Collects envelopes in an array. The fold-equivalence gate runs alineod's suite with one of
 * these attached and rebuilds projections from what it captured.
 */
export function memorySink(): MemorySink {
  const events: LedgerEnvelope[] = [];
  const sink = ((envelope: LedgerEnvelope) => {
    events.push(envelope);
  }) as { (envelope: LedgerEnvelope): void; events: readonly LedgerEnvelope[]; clear(): void };
  Object.defineProperty(sink, "events", { get: () => events });
  sink.clear = () => {
    events.length = 0;
  };
  return sink;
}

/**
 * Serialises each envelope as one JSON line.
 *
 * Takes a `write` rather than a path, because opening a file is the caller's decision and
 * this package does no IO of its own — which is also what keeps it testable without a
 * filesystem.
 */
export function jsonlSink(write: (line: string) => void): EventSink {
  return (envelope) => {
    write(`${JSON.stringify(envelope)}\n`);
  };
}
