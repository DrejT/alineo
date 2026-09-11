/** Agent routes: spawn under a run, inspect, prompt, steer, pause/resume, stop. */
import { Elysia } from "elysia";
import { SpawnAgentBody, StopAgentBody, PromptBody, SteerBody } from "../schema";
import { parseBody, withTimeout } from "./http";
import { spawnAgent } from "../engine/spawn";
import { stopAgent } from "../engine/lifecycle";
import { steerAgent } from "../engine/steer";
import { pauseAgent, resumeAgent } from "../engine/pause";
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
    // Skip the live fetch outright while paused (the bridge is frozen, this would just burn
    // the timeout below every time) — and bound it regardless, since "container reports
    // running" doesn't guarantee the bridge inside it is actually still responsive.
    const sessionStats = agent && view.state !== "paused" ? await withTimeout(agent.getSessionStats(), 2_000) : undefined;
    return { ...view, sessionStats };
  })

  .post("/agents/:agentId/prompt", async ({ params, body }) => {
    const { text } = parseBody(PromptBody, body);
    if (!get(params.agentId)) throw new HttpError(409, `agent ${params.agentId} is not live`);
    void driveTurn(params.agentId, text);
    return new Response(null, { status: 202 });
  })

  .post("/agents/:agentId/steer", async ({ params, body }) => {
    const { message } = parseBody(SteerBody, body);
    await steerAgent(params.agentId, message);
    return new Response(null, { status: 202 });
  })

  .post("/agents/:agentId/pause", async ({ params }) => {
    await pauseAgent(params.agentId);
    return new Response(null, { status: 202 });
  })

  .post("/agents/:agentId/resume", async ({ params }) => {
    await resumeAgent(params.agentId);
    return new Response(null, { status: 202 });
  })

  .post("/agents/:agentId/stop", async ({ params, body }) => {
    const { mode } = parseBody(StopAgentBody, body ?? {});
    await stopAgent(params.agentId, mode);
    return new Response(null, { status: 202 });
  });
