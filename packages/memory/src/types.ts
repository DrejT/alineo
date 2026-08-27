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

/**
 * Composite key every in-memory reference provider in this package scopes its storage by.
 *
 * Each part is escaped (`\` → `\\`, `:` → `\:`) before joining — without this, an untenanted
 * caller passing `resourceId: "acme:corp"` would produce the exact same string as a tenanted
 * caller passing `{teamId: "acme", resourceId: "corp"}`, silently colliding two different
 * callers' storage onto one key. On a backend keyed solely by this string (in-memory,
 * `@alineo-labs/sqlite-memory`), combined with `access-control.ts`'s `assertAccess()` skipping
 * its check entirely for a `ref` with no `teamId`, an unescaped join made that a real
 * cross-tenant read/write, not just a naming curiosity.
 */
export function scopeKey(ref: ResourceRef): string {
  const escape = (part: string) => part.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return ref.teamId ? `${escape(ref.teamId)}:${escape(ref.resourceId)}` : escape(ref.resourceId);
}
