/**
 * Who may touch what. With an `authenticate` hook set, every run belongs to the tenant that
 * created it, and a request reaches a run or an agent only through its own tenant. Everything
 * else in alineod (agents, handles, inbox, memory, results, events) is keyed by run or agent, so
 * one check on the run covers it.
 *
 * A caller who asks for a run or agent that is not theirs gets the same 404 as for one that does
 * not exist. A 403 would confirm the id is real.
 *
 * With no hook there is no principal, nothing here refuses, and alineod behaves as it always has.
 */
import { Elysia } from "elysia";
import { DEFAULT_TENANT, limitsOf, principalOf, specEnvAllowOf } from "./auth";
import { enforce, type Demand } from "./limits";
import { HttpError } from "./engine/errors";
import { getAgentRow, getRun } from "./state/projection";

/** The tenant that owns a run row. A run made before tenancy existed belongs to the default one. */
function ownerOf(row: { tenant_id: string | null }): string {
  return row.tenant_id ?? DEFAULT_TENANT;
}

/** The calling tenant, or `null` when authentication is off. */
export function tenantOf(request: Request): string | null {
  return principalOf(request)?.tenantId ?? null;
}

function assertRunAccess(request: Request, runId: string): void {
  const tenant = tenantOf(request);
  if (tenant === null) return;
  const run = getRun(runId);
  if (!run || ownerOf(run) !== tenant) {
    throw new HttpError(404, `no run ${runId}`, "RUN_NOT_FOUND");
  }
}

function assertAgentAccess(request: Request, agentId: string): void {
  const tenant = tenantOf(request);
  if (tenant === null) return;
  const agent = getAgentRow(agentId);
  const run = agent ? getRun(agent.run_id) : null;
  if (!agent || !run || ownerOf(run) !== tenant) {
    throw new HttpError(404, `no agent ${agentId}`, "AGENT_NOT_FOUND");
  }
}

/**
 * One choke point for every route that names a run or an agent in its path. It is global, so it
 * covers routes mounted through `.use()`. A route that names neither (`POST /runs`, `GET /runs`)
 * handles the tenant itself. `test/access.test.ts` lists every route and fails when a new one is
 * neither covered nor listed as exempt, so a route cannot be added unguarded by accident.
 */
export const accessPlugin = new Elysia({ name: "alineod-access" }).onBeforeHandle(
  { as: "global" },
  async ({ request, params }) => {
    const p = (params ?? {}) as Record<string, string | undefined>;
    if (p.runId !== undefined) assertRunAccess(request, p.runId);
    if (p.agentId !== undefined) assertAgentAccess(request, p.agentId);
    await assertNotSuspended(request);
  },
);

// What a suspended tenant may still do: read, and bring its own work down. `await` only waits, so
// it stays open too. Everything else that writes is refused.
const STILL_ALLOWED_WHEN_SUSPENDED = [/^\/agents\/[^/]+\/(stop|pause)$/, /^\/runs\/[^/]+\/await$/];

async function assertNotSuspended(request: Request): Promise<void> {
  const limits = limitsOf(request);
  const tenant = tenantOf(request);
  if (!limits || tenant === null) return;
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return;
  const path = new URL(request.url).pathname;
  if (STILL_ALLOWED_WHEN_SUSPENDED.some((re) => re.test(path))) return;
  if (await limits.suspended(tenant)) {
    throw new HttpError(403, "this tenant is suspended", "TENANT_SUSPENDED");
  }
}

/**
 * Refuse a request that would start work past the caller's limits. The limits may need an `await`
 * to read, so that happens first and the count and the check that follow it are synchronous.
 * Call this, then create the run or agent in the same tick with no `await` in between.
 */
export async function limitsFor(request: Request): Promise<(demand: Demand) => void> {
  const limits = limitsOf(request);
  if (!limits) return () => {};
  const tenant = tenantOf(request);
  const resolved = await limits.resolve(tenant);
  return (demand) => enforce(tenant, resolved, demand);
}

const ENV_REF = /\$\{([^}]+)\}/g;

function allowed(name: string, allow: readonly string[]): boolean {
  return allow.some((a) => (a.endsWith("*") ? name.startsWith(a.slice(0, -1)) : a === name));
}

/** Every `${NAME}` in the strings of an `env` value, whether a plain string or a credential binding. */
function envRefs(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(ENV_REF)) out.push(m[1] ?? "");
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) envRefs(v, out);
  }
}

/**
 * Apply the request's policy to a spec before alineod stores or runs it:
 *
 * 1. With an env allowlist, refuse a `${NAME}` in `env` that is not on it.
 * 2. With a tenant other than the default, put the tenant in front of the spec's memory scope
 *    (`resourceId`, `teamId`), so two tenants who pick the same name do not share memory. The
 *    rewritten spec is what alineod persists, so the memory routes and the agent itself agree.
 */
export function admitSpec<T extends Record<string, unknown>>(request: Request, spec: T): T {
  const allow = specEnvAllowOf(request);
  if (allow) {
    const refs: string[] = [];
    envRefs(spec.env, refs);
    const bad = refs.find((name) => !allowed(name, allow));
    if (bad !== undefined) {
      throw new HttpError(
        400,
        `spec env references \${${bad}}, which this alineod does not allow. Use a literal value.`,
        "INVALID_ARGUMENT",
      );
    }
  }
  const tenant = tenantOf(request);
  if (tenant === null) return spec;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (tenant === DEFAULT_TENANT) {
    // The default tenant keeps its scopes unprefixed, so existing memory stays reachable. A named
    // tenant's scope always starts `<tenant>:`, and a tenant id has no colon (`authPlugin` checks).
    // So a default-tenant caller must not be able to write a name that looks like one.
    for (const field of ["name", "resourceId", "teamId"] as const) {
      if (str(spec[field])?.includes(":")) {
        throw new HttpError(
          400,
          `spec ${field} may not contain ':' on this daemon (the colon separates a tenant from its memory scope)`,
          "INVALID_ARGUMENT",
        );
      }
    }
    return spec;
  }
  return {
    ...spec,
    resourceId: `${tenant}:${str(spec.resourceId) ?? str(spec.name) ?? "agent"}`,
    ...(str(spec.teamId) !== undefined ? { teamId: `${tenant}:${str(spec.teamId)}` } : {}),
  };
}
