/**
 * The durable identity memory is scoped by — deliberately NOT a `sandboxId` or session id.
 * A `sandboxId` identifies one sandbox *session* (what the ledger already keys episodic
 * events by); a `resourceId` is expected to outlive any number of those sessions, because
 * the entire point of working/semantic memory is surviving past the session it was learned
 * in. Conflating the two would silently break that guarantee.
 *
 * `teamId` is optional widening for shared/team memory — every provider receives it, but
 * what a given provider does with it (row-level security, app-layer filtering, ignoring it)
 * is that provider's problem, not this package's.
 */
export interface ResourceRef {
  resourceId: string;
  teamId?: string;
}

/** Composite key every in-memory reference provider in this package scopes its storage by. */
export function scopeKey(ref: ResourceRef): string {
  return ref.teamId ? `${ref.teamId}:${ref.resourceId}` : ref.resourceId;
}
