/**
 * Optional limits on what one tenant may use, and a switch to suspend one.
 *
 * alineo ships the mechanism and no numbers. Every limit is off (`0` or unset) until the operator
 * sets it, so a self-hoster who sets nothing sees no change. An operator who serves other people
 * sets defaults from the environment (`ALINEOD_MAX_*`) and may override them per tenant with a
 * `limitsFor` function. The numbers, who gets more, and what suspends a tenant are the
 * operator's policy and live in the operator's code.
 *
 * What is counted: open runs, agents that hold a sandbox, and agents created in a rolling window.
 * What is not: model tokens or money. alineod does not measure them. Sandboxes are most of the
 * cost, and capping how many exist and how fast they are made caps that part.
 *
 * With authentication off there is one tenant, `null`, and the defaults apply to everyone.
 */
import {
  AGENT_WINDOW_MS,
  MAX_AGENTS_PER_WINDOW,
  MAX_LIVE_AGENTS,
  MAX_OPEN_RUNS,
  MAX_RUN_AGE_MS,
} from "../config";
import { DEFAULT_TENANT } from "./auth";
import { HttpError } from "./engine/errors";
import {
  countAgentsSince,
  countOpenRuns,
  countSandboxAgents,
  type TenantScope,
} from "./state/projection";

export interface TenantLimits {
  /** Runs open at once. */
  maxOpenRuns?: number;
  /** Agents holding a sandbox at once, across all the tenant's runs. */
  maxLiveAgents?: number;
  /** Agents created within `windowMs`, alive or not. */
  maxAgentsPerWindow?: { count: number; windowMs: number };
  /** An open run older than this many ms is torn down. */
  maxRunAgeMs?: number;
}

export interface LimitsOptions {
  /** Applied to every tenant. Default: the `ALINEOD_MAX_*` environment variables. */
  defaults?: TenantLimits;
  /**
   * Per-tenant overrides, merged over `defaults` field by field. Return `undefined` to use the
   * defaults as they are. May be async. A function that throws refuses the request.
   */
  limitsFor?: (tenantId: string) => TenantLimits | undefined | Promise<TenantLimits | undefined>;
  /**
   * The kill switch. While it answers `true` for a tenant, that tenant's requests that start or
   * continue work are refused with `403` (`TENANT_SUSPENDED`), and the sweep tears down its open
   * runs. Reads and stopping stay allowed. May be async. A function that throws refuses the
   * request, so a broken switch fails closed.
   */
  isSuspended?: (tenantId: string) => boolean | Promise<boolean>;
}

/** The limits the environment sets. A zero or unset value is no limit. */
function limitsFromEnv(): TenantLimits {
  return {
    ...(MAX_OPEN_RUNS > 0 ? { maxOpenRuns: MAX_OPEN_RUNS } : {}),
    ...(MAX_LIVE_AGENTS > 0 ? { maxLiveAgents: MAX_LIVE_AGENTS } : {}),
    ...(MAX_AGENTS_PER_WINDOW > 0
      ? { maxAgentsPerWindow: { count: MAX_AGENTS_PER_WINDOW, windowMs: AGENT_WINDOW_MS } }
      : {}),
    ...(MAX_RUN_AGE_MS > 0 ? { maxRunAgeMs: MAX_RUN_AGE_MS } : {}),
  };
}

/** What one request or sweep asks for, so the check can count it before it exists. */
export interface Demand {
  runs: number;
  agents: number;
}

export class Limits {
  readonly defaults: TenantLimits;

  constructor(private readonly options: LimitsOptions = {}) {
    this.defaults = options.defaults ?? limitsFromEnv();
  }

  /** True when something here can ever refuse a request or tear a run down. */
  get active(): boolean {
    return (
      Object.keys(this.defaults).length > 0 ||
      this.options.limitsFor !== undefined ||
      this.options.isSuspended !== undefined
    );
  }

  /** True when the sweep has work to do: a run-age limit or a suspension hook. */
  get needsSweep(): boolean {
    return (
      this.defaults.maxRunAgeMs !== undefined ||
      this.options.limitsFor !== undefined ||
      this.options.isSuspended !== undefined
    );
  }

  async resolve(tenant: string | null): Promise<TenantLimits> {
    if (tenant === null || !this.options.limitsFor) return this.defaults;
    return { ...this.defaults, ...(await this.options.limitsFor(tenant)) };
  }

  async suspended(tenant: string | null): Promise<boolean> {
    if (tenant === null || !this.options.isSuspended) return false;
    return this.options.isSuspended(tenant);
  }
}

const scopeOf = (tenant: string | null): TenantScope => ({
  tenant,
  legacyTenant: DEFAULT_TENANT,
});

function refuse(message: string): never {
  throw new HttpError(429, message, "LIMIT_EXCEEDED");
}

/**
 * Refuse when `demand` more would pass one of `limits`. Synchronous on purpose: the caller
 * resolves the limits first (they may be async) and then checks and creates with no `await`
 * between, so two requests cannot both see room for one more.
 */
export function enforce(tenant: string | null, limits: TenantLimits, demand: Demand): void {
  const scope = scopeOf(tenant);
  if (limits.maxOpenRuns !== undefined && demand.runs > 0) {
    const open = countOpenRuns(scope);
    if (open + demand.runs > limits.maxOpenRuns) {
      refuse(
        `limit reached: ${open} runs are open and the limit is ${limits.maxOpenRuns}. Close a run first.`,
      );
    }
  }
  if (limits.maxLiveAgents !== undefined && demand.agents > 0) {
    const live = countSandboxAgents(scope);
    if (live + demand.agents > limits.maxLiveAgents) {
      refuse(
        `limit reached: ${live} agents hold a sandbox and the limit is ${limits.maxLiveAgents}. Stop an agent or close a run first.`,
      );
    }
  }
  const window = limits.maxAgentsPerWindow;
  if (window && demand.agents > 0) {
    const made = countAgentsSince(scope, Date.now() - window.windowMs);
    if (made + demand.agents > window.count) {
      refuse(
        `limit reached: ${made} agents were created in the last ${Math.round(window.windowMs / 60_000)} minutes and the limit is ${window.count}. Try again later.`,
      );
    }
  }
}
