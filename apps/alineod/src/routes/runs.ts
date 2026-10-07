/** Run routes: create, inspect the tree, tear down. */
import { Elysia } from "elysia";
import { CreateRunBody } from "../schema";
import { parseBody } from "./http";
import { createRun } from "../engine/runs";
import { deleteRun } from "../engine/lifecycle";
import { getRun, getRunAgentViews, runAsOf } from "../state/projection";
import { HttpError } from "../engine/errors";
import { sseResponse } from "./sse";

export const runsRoutes = new Elysia({ prefix: "/runs" })
  .post("/", ({ body, set }) => {
    set.status = 202; // async — provisioning happens in the background, poll for real state
    return createRun(parseBody(CreateRunBody, body));
  })

  .get("/:runId", ({ params }) => {
    const agents = getRunAgentViews(params.runId);
    if (agents.length === 0) throw new HttpError(404, `no run ${params.runId}`);
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
