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
import { DEFAULT_TENANT, principalOf, specEnvAllowOf } from "./auth";
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
  ({ request, params }) => {
    const p = (params ?? {}) as Record<string, string | undefined>;
    if (p.runId !== undefined) assertRunAccess(request, p.runId);
    if (p.agentId !== undefined) assertAgentAccess(request, p.agentId);
  },
);

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
  if (tenant === null || tenant === DEFAULT_TENANT) return spec;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    ...spec,
    resourceId: `${tenant}:${str(spec.resourceId) ?? str(spec.name) ?? "agent"}`,
    ...(str(spec.teamId) !== undefined ? { teamId: `${tenant}:${str(spec.teamId)}` } : {}),
  };
}
