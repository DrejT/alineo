import type { AgentSpec } from "./agent-spec";

/**
 * The durable identity an agent's memory is scoped by — `resourceId`, defaulting to `name`,
 * plus the optional `teamId`.
 *
 * This is the one place the rule lives. The SDK (`Alineo.resourceId`, a spawned child's frozen
 * `resourceId`, the ledger's `resourceId` threading) and alineod (which resolves an agent's
 * memory scope from its persisted spec, with no live `Alineo` to ask) both call it, so a change
 * to the rule cannot leave one of them scoping memory differently from the other.
 *
 * `resourceId` is `??`, not `||`: an explicitly set value wins even when it is falsy, exactly as
 * it did when this was written inline.
 */
export function resourceRefOf(spec: Pick<AgentSpec, "name" | "resourceId" | "teamId">): {
  resourceId: string;
  teamId?: string;
} {
  const resourceId = spec.resourceId ?? spec.name;
  return spec.teamId === undefined ? { resourceId } : { resourceId, teamId: spec.teamId };
}
