import type { LedgerEnvelope, PersistedEnvelope } from "@alineo-labs/schema/types";

/**
 * The narrow read/append surface a durable store has to offer.
 *
 * Deliberately small. `IStorageAdapter` in `@alineo-labs/core` has fourteen methods mixing an
 * event log, read models and an environment cache, and users are expected to implement it —
 * which is why two of the three internal consumers hand-rolled `bun:sqlite` instead. This is
 * the log, and nothing else.
 *
 * Phase 3 backs it with the real sqlite and postgres engines. `MemoryStorage` below is enough
 * for tests and for the fold helpers.
 */
export interface LedgerStorage {
  /**
   * Append one event and return it with `durable` filled in.
   *
   * The store assigns `seq` — it is the only thing that can, being the single writer for an
   * aggregate.
   */
  append(envelope: LedgerEnvelope): PersistedEnvelope;
  /** Every persisted event for an aggregate, in `seq` order. */
  read(aggregate: string): PersistedEnvelope[];
  /** Events after `seq`, in order. What an SSE reconnect replays. */
  readSince(aggregate: string, seq: number): PersistedEnvelope[];
}

/** An in-memory `LedgerStorage`. Not durable; for tests and fold helpers. */
export class MemoryStorage implements LedgerStorage {
  readonly #byAggregate = new Map<string, PersistedEnvelope[]>();

  append(envelope: LedgerEnvelope): PersistedEnvelope {
    const aggregate = envelope.durable?.aggregate ?? envelope.runId ?? envelope.agentId;
    if (!aggregate) {
      throw new Error(
        `Cannot append ${envelope.type}: no aggregate. Set durable.aggregate, or a runId or ` +
          `agentId to derive it from.`,
      );
    }
    const rows = this.#byAggregate.get(aggregate) ?? [];
    if (rows.length === 0) this.#byAggregate.set(aggregate, rows);
    const persisted: PersistedEnvelope = {
      ...envelope,
      durable: {
        aggregate,
        seq: (rows.at(-1)?.durable.seq ?? 0) + 1,
        version: envelope.durable?.version ?? 1,
      },
    };
    rows.push(persisted);
    return persisted;
  }

  read(aggregate: string): PersistedEnvelope[] {
    return [...(this.#byAggregate.get(aggregate) ?? [])];
  }

  readSince(aggregate: string, seq: number): PersistedEnvelope[] {
    return this.read(aggregate).filter((e) => e.durable.seq > seq);
  }

  /** Every aggregate this store holds. What a boot-time rebuild iterates. */
  aggregates(): string[] {
    return [...this.#byAggregate.keys()];
  }
}
