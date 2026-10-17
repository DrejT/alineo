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
 * Put envelopes in ledger order: by `durable.seq` within an aggregate, by timestamp across them.
 *
 * A sink sees events in emission order, which is usually persist order but is not guaranteed
 * to be across two aggregates. Comparing a sink's stream against a store's rows means putting
 * them in the same order first, or the comparison fails for a reason that has nothing to do
 * with the thing being tested.
 *
 * "Seq within, ts across" is not a total order on its own: a clock that ran backwards inside
 * one aggregate makes it cyclic (a < b by time, b < c by time, c < a by seq), and the result
 * then depends on the sort algorithm, so two runtimes disagree. This resolves it by giving
 * every event the highest timestamp seen so far in its aggregate, in seq order. Seq is the
 * truth inside an aggregate, so an event never sorts earlier than one before it. For events
 * whose timestamps do not run backwards, which is every event a healthy ledger holds, this
 * is the plain ts-and-seq order. Ties break on aggregate, then seq, so the order is total.
 */
export function inLedgerOrder(events: readonly LedgerEnvelope[]): LedgerEnvelope[] {
  const effective = new Map<LedgerEnvelope, number>();
  for (const group of byAggregate(events).values()) {
    let high = Number.NEGATIVE_INFINITY;
    for (const event of [...group].sort((a, b) => a.durable!.seq - b.durable!.seq)) {
      high = Math.max(high, event.ts);
      effective.set(event, high);
    }
  }
  const when = (e: LedgerEnvelope): number => effective.get(e) ?? e.ts;
  return [...events].sort((a, b) => {
    if (when(a) !== when(b)) return when(a) - when(b);
    const byAgg = (a.durable?.aggregate ?? "").localeCompare(b.durable?.aggregate ?? "");
    if (byAgg !== 0) return byAgg;
    return (a.durable?.seq ?? 0) - (b.durable?.seq ?? 0);
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
