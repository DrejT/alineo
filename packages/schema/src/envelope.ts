/**
 * The one record shape an event takes, whichever layer emitted it.
 *
 * Today the same idea is written three ways: the SDK's `LedgerEntry` (keyed by name +
 * sandboxId + stepIndex, ordered by timestamp), alineod's ledger row (`seq`, `run_id`,
 * `agent_id`, `ts`, `event`, `payload`), and the harness's bare `{ type, ...fields }` stream.
 * A consumer reading a run end to end has to know all three.
 *
 * This is mostly a formalisation rather than an invention — alineod's row is already five of
 * these eight fields.
 */

/** A pointer back to a persisted event, for `causedBy`. */
export interface EventRef {
  /** The aggregate the referenced event was persisted under — a run, or a sandbox session. */
  aggregate: string;
  seq: number;
}

/**
 * What a writer stamps on an event once it is persisted.
 *
 * Absent on a stream-only event, and absent on a durable one until it has actually been
 * written — which is the distinction `BusMessage.id` already draws in alineod today ("the
 * ledger `seq` for persisted events, absent otherwise").
 */
export interface DurableRef {
  /**
   * What the `seq` counts within: the run for alineod, the sandbox session for the SDK.
   *
   * Scoped rather than global on purpose. A monotone sequence needs a single writer, and
   * there are two here — alineod's `bun:sqlite` and the SDK's storage adapter, in different
   * processes. A top-level `seq` would be a promise neither could keep.
   */
  aggregate: string;
  /** Monotone within `aggregate`. Also what SSE hands back as `Last-Event-ID`. */
  seq: number;
  /** Version of this `type`'s `data` shape, from its definition. */
  version: number;
}

export interface LedgerEnvelope<T extends string = string, D = unknown> {
  /** Envelope version. Bumped only if these outer fields change, never for a `data` change. */
  v: 1;
  /** Epoch ms. */
  ts: number;
  /** `<subject>.<past-tense verb>` — `agent.spawned`, `exec.completed`. */
  type: T;
  runId?: string;
  agentId?: string;
  /**
   * Reserved. Nothing generates turn ids yet; the field ships unpopulated because adding a
   * field to a persisted envelope later costs a `v` bump and a migration, and adding it now
   * costs one optional property.
   */
  turnId?: string;
  /** The decision this fact followed from, where the emitter knows it. */
  causedBy?: EventRef;
  /** Present once persisted. See `DurableRef`. */
  durable?: DurableRef;
  data: D;
}

/** An envelope that has been persisted, so `durable` is known to be there. */
export type PersistedEnvelope<T extends string = string, D = unknown> = LedgerEnvelope<T, D> & {
  durable: DurableRef;
};

export function isPersisted<T extends string, D>(
  envelope: LedgerEnvelope<T, D>,
): envelope is PersistedEnvelope<T, D> {
  return envelope.durable !== undefined;
}
