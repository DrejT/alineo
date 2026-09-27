import type { z } from "zod";
import { isSubject } from "./vocabulary";
import type { LedgerEnvelope } from "./envelope";

/**
 * One definition per event, consumed three ways: the writer reads `durable` to decide whether
 * to persist, the reader reads `schema` to validate, and the vocabulary check reads `type`.
 *
 * Replaces the hardcoded `PERSISTED_HARNESS_EVENTS` Set in alineod's `emit.ts` — the
 * durable/stream-only split becomes a property of the event instead of a list kept in step by
 * hand somewhere else.
 */
export interface EventDefinition<T extends string = string, S extends z.ZodType = z.ZodType> {
  /** `<subject>.<past-tense verb>`. */
  type: T;
  /**
   * Whether this event earns a row.
   *
   * Durable: decisions, lifecycle, turn boundaries, tool calls, and permission/egress/
   * credential facts — anything a projection folds or an audit needs.
   * Stream-only: text and message deltas, exec output chunks — high-volume, replaceable by
   * the durable event that follows, and not worth the write.
   */
  durable: boolean;
  /** Version of `data`'s shape. Stamped onto `durable.version` when persisted. */
  version: number;
  schema: S;
  /** One line, for generated docs and for a reader meeting the name cold. */
  description?: string;
}

/** The `data` a definition carries. */
export type EventData<D> = D extends EventDefinition<string, infer S> ? z.infer<S> : never;

/** The envelope a definition produces. */
export type EnvelopeOf<D> =
  D extends EventDefinition<infer T, infer S> ? LedgerEnvelope<T, z.infer<S>> : never;

/**
 * Every definition, by type. Populated as a side effect of `defineEvent`, which is why the
 * event files must be imported for the registry to be complete — `index.ts` imports all five.
 */
const registry = new Map<string, EventDefinition>();

/** A `type` that is well-formed but whose subject is not in `SUBJECTS`. */
const TYPE_SHAPE = /^([a-z]+)\.([a-z][a-z_]*)$/;

export function defineEvent<const T extends string, S extends z.ZodType>(
  definition: EventDefinition<T, S>,
): EventDefinition<T, S> {
  const match = TYPE_SHAPE.exec(definition.type);
  if (!match) {
    throw new Error(
      `Event type "${definition.type}" is not "<subject>.<past_tense_verb>" in lower snake case.`,
    );
  }
  if (!isSubject(match[1]!)) {
    throw new Error(
      `Event type "${definition.type}" has subject "${match[1]}", which is not in SUBJECTS. ` +
        `Add it to @alineo-labs/schema's vocabulary, or name the event after a subject that ` +
        `is already there.`,
    );
  }
  // Two definitions under one name would make the registry silently prefer whichever loaded
  // last, and a reader validating against the wrong schema is worse than a crash at import.
  const existing = registry.get(definition.type);
  if (existing && existing !== (definition as EventDefinition)) {
    throw new Error(`Event type "${definition.type}" is defined twice.`);
  }
  registry.set(definition.type, definition as EventDefinition);
  return definition;
}

/** Every registered definition. Order is definition order, which is file order. */
export function allEvents(): EventDefinition[] {
  return [...registry.values()];
}

export function getEvent(type: string): EventDefinition | undefined {
  return registry.get(type);
}

/** The subset that earns a ledger row. */
export function durableEvents(): EventDefinition[] {
  return allEvents().filter((d) => d.durable);
}
