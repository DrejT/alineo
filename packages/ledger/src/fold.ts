import type { LedgerEnvelope } from "@alineo-labs/schema/types";

/**
 * Replay helpers, used by the fold-equivalence gate.
 *
 * The gate is the one that actually proves dual-write is honest: run a suite with a
 * `memorySink()` attached, rebuild projections from what it captured, and deep-equal the
 * result against the projection rebuilt from the store's own rows. If the two writes ever
 * disagree, that comparison is where it surfaces — not in production, months later.
 */

/** Left-fold a stream of envelopes into a projection. */
export function fold<S>(
  events: Iterable<LedgerEnvelope>,
  initial: S,
  apply: (state: S, envelope: LedgerEnvelope) => S,
): S {
  let state = initial;
  for (const envelope of events) state = apply(state, envelope);
  return state;
}

/**
 * Sort by `durable.seq` within each aggregate, then by timestamp across them.
 *
 * A sink sees events in emission order, which is usually persist order but is not guaranteed
 * to be across two aggregates. Comparing a sink's stream against a store's rows means putting
 * them in the same order first, or the comparison fails for a reason that has nothing to do
 * with the thing being tested.
 */
export function inLedgerOrder(events: readonly LedgerEnvelope[]): LedgerEnvelope[] {
  return [...events].sort((a, b) => {
    const sameAggregate = a.durable && b.durable && a.durable.aggregate === b.durable.aggregate;
    if (sameAggregate) return a.durable!.seq - b.durable!.seq;
    return a.ts - b.ts;
  });
}

/** Only the events that earned a row — what a store holds and a rebuild sees. */
export function persistedOnly(events: readonly LedgerEnvelope[]): LedgerEnvelope[] {
  return events.filter((e) => e.durable !== undefined);
}

/** Group by aggregate, preserving order within each. */
export function byAggregate(events: readonly LedgerEnvelope[]): Map<string, LedgerEnvelope[]> {
  const groups = new Map<string, LedgerEnvelope[]>();
  for (const event of events) {
    const aggregate = event.durable?.aggregate;
    if (!aggregate) continue;
    const group = groups.get(aggregate);
    if (group) group.push(event);
    else groups.set(aggregate, [event]);
  }
  return groups;
}
