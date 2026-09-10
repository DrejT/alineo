/** Run routes: create, inspect the tree, tear down. */
import { Elysia } from "elysia";
import { CreateRunBody } from "../schema";
import { parseBody } from "./http";
import { createRun } from "../engine/runs";
import { deleteRun } from "../engine/lifecycle";
import { getRunAgentViews, runAsOf } from "../state/projection";
import { HttpError } from "../engine/errors";
import { sseResponse } from "./sse";

export const runsRoutes = new Elysia({ prefix: "/runs" })
  .post("/", async ({ body }) => {
    return createRun(parseBody(CreateRunBody, body));
  })

  .get("/:runId", ({ params }) => {
    const agents = getRunAgentViews(params.runId);
    if (agents.length === 0) throw new HttpError(404, `no run ${params.runId}`);
    const root = agents.find((a) => a.parentAgentId === null) ?? null;
    return {
      runId: params.runId,
      rootAgentId: root?.agentId ?? null,
      agents,
      asOf: runAsOf(params.runId),
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
