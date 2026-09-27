/**
 * Sandbox leak check: compare what alineod's ledger says it still needs against what OpenSandbox
 * actually has running.
 *
 * A finished agent (`done`/`failed`) keeps its sandbox on purpose — it stays promptable and usable
 * as a spawn parent — until it is stopped, which records `agent.released`. So "needs its sandbox"
 * is: still live, or finished and not released.
 *
 * Other clients can share the same OpenSandbox (SDK scripts, the CLI's `alineo start`, the
 * playground), so a sandbox alineod has never heard of is reported as foreign and never closed.
 */
import type { Database } from "bun:sqlite";

export type SandboxVerdict =
  /** alineod still needs it. */
  | "in-use"
  /** alineod has finished with it (aborted, lost, released) but it is still there. Safe to close. */
  | "leaked"
  /** Unknown to alineod. Belongs to some other client, or to a run that was deleted. Never closed. */
  | "foreign";

export interface LiveSandbox {
  id: string;
  state: string;
}

export interface SandboxReport {
  sandboxId: string;
  state: string;
  verdict: SandboxVerdict;
  agentId: string | null;
  runId: string | null;
  agentState: string | null;
  outcome: string | null;
}

/** An agent alineod still needs a sandbox for, whose sandbox OpenSandbox no longer has. */
export interface MissingSandbox {
  sandboxId: string;
  agentId: string;
  runId: string;
  agentState: string;
}

export interface LeakReport {
  sandboxes: SandboxReport[];
  missing: MissingSandbox[];
}

interface AgentRow {
  agent_id: string;
  run_id: string;
  state: string;
  outcome: string | null;
  sandbox_id: string;
}

/** Outcomes that keep a sandbox open for further prompting until the agent is released. */
const OPEN_AFTER_FINISH = new Set(["success", "failed"]);

export function classify(db: Database, live: LiveSandbox[]): LeakReport {
  const agents = db
    .query<AgentRow, []>(
      "SELECT agent_id, run_id, state, outcome, sandbox_id FROM agents WHERE sandbox_id IS NOT NULL",
    )
    .all();
  const released = new Set(
    db
      .query<{ agent_id: string }, []>(
        "SELECT DISTINCT agent_id FROM ledger WHERE event = 'agent.released' AND agent_id IS NOT NULL",
      )
      .all()
      .map((r) => r.agent_id),
  );

  const needs = (a: AgentRow): boolean =>
    a.outcome === null || (OPEN_AFTER_FINISH.has(a.outcome) && !released.has(a.agent_id));

  const bySandbox = new Map(agents.map((a) => [a.sandbox_id, a]));
  const sandboxes: SandboxReport[] = live.map((sb) => {
    const a = bySandbox.get(sb.id);
    return {
      sandboxId: sb.id,
      state: sb.state,
      verdict: !a ? "foreign" : needs(a) ? "in-use" : "leaked",
      agentId: a?.agent_id ?? null,
      runId: a?.run_id ?? null,
      agentState: a?.state ?? null,
      outcome: a?.outcome ?? null,
    };
  });

  const liveIds = new Set(live.map((sb) => sb.id));
  const missing = agents
    .filter((a) => needs(a) && !liveIds.has(a.sandbox_id))
    .map((a) => ({
      sandboxId: a.sandbox_id,
      agentId: a.agent_id,
      runId: a.run_id,
      agentState: a.state,
    }));

  return { sandboxes, missing };
}

/** Every sandbox on the server. OpenSandbox pages with `page`/`pageSize` (max 200). */
export async function listLiveSandboxes(serverUrl: string, apiKey: string): Promise<LiveSandbox[]> {
  const out: LiveSandbox[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${serverUrl}/v1/sandboxes?page=${page}&pageSize=200`, {
      headers: { "OPEN-SANDBOX-API-KEY": apiKey },
    });
    if (!res.ok) throw new Error(`GET /v1/sandboxes: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      items: { id: string; status?: { state?: string } }[];
      pagination?: { hasNextPage?: boolean };
    };
    for (const sb of body.items) out.push({ id: sb.id, state: sb.status?.state ?? "Unknown" });
    if (!body.pagination?.hasNextPage) return out;
  }
}

export async function closeSandbox(serverUrl: string, apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${serverUrl}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: { "OPEN-SANDBOX-API-KEY": apiKey },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE /v1/sandboxes/${id}: HTTP ${res.status} ${await res.text()}`);
  }
}
