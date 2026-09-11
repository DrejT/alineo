/** Agent routes: spawn under a run, inspect, prompt, stop. */
import { Elysia } from "elysia";
import { SpawnAgentBody, StopAgentBody, PromptBody } from "../schema";
import { parseBody } from "./http";
import { spawnAgent } from "../engine/spawn";
import { stopAgent } from "../engine/lifecycle";
import { driveTurn } from "../engine/stream";
import { get } from "../engine/registry";
import { getAgentView } from "../state/projection";
import { HttpError } from "../engine/errors";

export const agentsRoutes = new Elysia()
  .post("/runs/:runId/agents", ({ params, body, set }) => {
    set.status = 202; // async — the fork (and any waitFor hold) happens in the background
    return spawnAgent(params.runId, parseBody(SpawnAgentBody, body));
  })

  .get("/agents/:agentId", async ({ params }) => {
    const view = getAgentView(params.agentId);
    if (!view) throw new HttpError(404, `no agent ${params.agentId}`);
    const agent = get(params.agentId);
    let sessionStats: unknown;
    if (agent) {
      try {
        sessionStats = await agent.getSessionStats();
      } catch {
        /* bridge may be gone */
      }
    }
    return { ...view, sessionStats };
  })

  .post("/agents/:agentId/prompt", async ({ params, body }) => {
    const { text } = parseBody(PromptBody, body);
    if (!get(params.agentId)) throw new HttpError(409, `agent ${params.agentId} is not live`);
    void driveTurn(params.agentId, text);
    return new Response(null, { status: 202 });
  })

  .post("/agents/:agentId/stop", async ({ params, body }) => {
    const { mode } = parseBody(StopAgentBody, body ?? {});
    await stopAgent(params.agentId, mode);
    return new Response(null, { status: 202 });
  });
