/** Run routes: create, inspect the tree, tear down. */
import { Elysia } from "elysia";
import { CreateRunBody } from "../schema";
import { parseBody } from "./http";
import { createRun } from "../engine/runs";
import { deleteRun } from "../engine/lifecycle";
import { getRun, getRunAgentViews, listRuns, runAsOf } from "../state/projection";
import { admitSpec, tenantOf } from "../access";
import { DEFAULT_TENANT } from "../auth";
import { HttpError } from "../engine/errors";
import { sseResponse } from "./sse";

export const runsRoutes = new Elysia({ prefix: "/runs" })
  .post("/", ({ body, set, request }) => {
    const parsed = parseBody(CreateRunBody, body);
    const spec = admitSpec(request, parsed.spec);
    set.status = 202; // async — provisioning happens in the background, poll for real state
    return createRun({ ...parsed, spec }, tenantOf(request));
  })

  // Only the caller's runs when authentication is on, every run when it is off.
  .get("/", ({ query, request }) => {
    const limit = Number(query.limit ?? "100");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HttpError(400, "limit must be an integer between 1 and 500", "INVALID_ARGUMENT");
    }
    const state = query.state ?? null;
    if (state !== null && state !== "open" && state !== "closed") {
      throw new HttpError(400, 'state must be "open" or "closed"', "INVALID_ARGUMENT");
    }
    const rows = listRuns({
      tenant: tenantOf(request),
      legacyTenant: DEFAULT_TENANT,
      state,
      limit,
    });
    return {
      runs: rows.map((r) => ({
        runId: r.run_id,
        rootAgentId: r.root_id,
        state: r.state,
        closeWhen: r.close_when,
        createdAt: r.created_at,
      })),
    };
  })

  .get("/:runId", ({ params }) => {
    const agents = getRunAgentViews(params.runId);
    if (agents.length === 0) throw new HttpError(404, `no run ${params.runId}`, "RUN_NOT_FOUND");
    const root = agents.find((a) => a.parentAgentId === null) ?? null;
    const run = getRun(params.runId);
    return {
      runId: params.runId,
      rootAgentId: root?.agentId ?? null,
      agents,
      asOf: runAsOf(params.runId),
      // `run` can briefly be null: `run.started` folds a row the instant createRun() returns
      // (synchronous, no I/O — see runs.ts's own comment), same instant the root agent's own
      // row becomes visible, so this only shows up in theory, not in a real race.
      closeWhen: run?.close_when ?? "explicit",
      state: run?.state ?? "open",
    };
  })

  .delete("/:runId", async ({ params }) => {
    await deleteRun(params.runId);
    return new Response(null, { status: 204 });
  })

  // SSE lives under /runs/:runId/events — kept out of the schema layer (raw Response).
  .get("/:runId/events", ({ params, headers }) => {
    const lastEventId = Number(headers["last-event-id"] ?? "0") || 0;
    return sseResponse(params.runId, lastEventId);
  });
