/**
 * Operator-side waits (research/tier-1-2-plan.md #4) — long-polls, capped at
 * MAX_RESULT_WAIT_SECONDS like `GET /agents/:id/result`:
 *
 *   GET  /agents/:agentId/await?scope=subtree&wait=<s>   quiescence of the agent's subtree
 *   POST /runs/:runId/await { agents, mode, k?, onDepFailure?, wait }   a wait regime, no spawn
 *   POST /runs/:runId/await { subtree, wait }                         quiescence, same as the GET
 */
import { Elysia } from "elysia";
import { RunAwaitBody } from "../schema";
import { parseBody } from "./http";
import { HttpError } from "../engine/errors";
import { getAgentRow } from "../state/projection";
import { waitQuiescent } from "../engine/quiescence";
import {
  atDeadline,
  evaluateWait,
  normalizeWait,
  validateWait,
  waitUntil,
} from "../engine/waitfor";
import { MAX_RESULT_WAIT_SECONDS } from "../../config";

const waitMs = (seconds: unknown) =>
  Math.min(Number(seconds ?? 0) || 0, MAX_RESULT_WAIT_SECONDS) * 1000;

export const awaitRoutes = new Elysia()
  .get("/agents/:agentId/await", async ({ params, query }) => {
    if (query.scope !== undefined && query.scope !== "subtree") {
      throw new HttpError(400, `unsupported scope ${String(query.scope)} (only "subtree")`);
    }
    const view = await waitQuiescent(params.agentId, waitMs(query.wait));
    if (!view) throw new HttpError(404, `no agent ${params.agentId}`);
    return view;
  })

  .post("/runs/:runId/await", async ({ params, body }) => {
    const req = parseBody(RunAwaitBody, body);

    if (req.subtree) {
      const root = getAgentRow(req.subtree);
      if (!root || root.run_id !== params.runId) {
        throw new HttpError(404, `no agent ${req.subtree} in run ${params.runId}`);
      }
      const view = (await waitQuiescent(req.subtree, waitMs(req.wait)))!;
      return {
        outcome: view.quiescent ? "satisfied" : "pending",
        selected: view.quiescent ? view.members.map((m) => m.agentId) : [],
        settled: view.members
          .filter((m) => m.outcome !== null)
          .map((m) => ({ agentId: m.agentId, outcome: m.outcome })),
        pending: view.members.filter((m) => m.outcome === null).map((m) => m.agentId),
      };
    }

    const wait = normalizeWait({
      agents: req.agents!,
      mode: req.mode,
      k: req.k,
      onDepFailure: req.onDepFailure,
    })!;
    const problem = validateWait(wait);
    if (problem) throw new HttpError(400, problem);
    for (const id of wait.agents) {
      const row = getAgentRow(id);
      if (!row || row.run_id !== params.runId) {
        throw new HttpError(400, `unknown agent ${id} in run ${params.runId}`);
      }
    }
    const out = await waitUntil(params.runId, () => evaluateWait(wait), {
      timeoutMs: waitMs(req.wait),
      onTimeout: () => null,
    });
    if (out) {
      return {
        outcome: out.outcome === "deadline" ? "pending" : out.outcome,
        selected: out.selected,
        settled: out.settled,
        pending: out.pending,
      };
    }
    const now = atDeadline({ ...wait, onDeadline: "proceed" }); // a snapshot: what's settled so far
    return {
      outcome: "pending" as const,
      selected: [],
      settled: now.settled,
      pending: now.pending,
    };
  });
