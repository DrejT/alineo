/** Natural-language swarm creation: plan, then realize. See PLAN.md §5. */
import { Elysia } from "elysia";
import { z } from "zod";
import { planSwarm } from "../engine/swarm-planner";
import { createSwarm } from "../engine/swarms";
import { parseBody } from "./http";

const PlanBody = z.object({ prompt: z.string().min(1) });

const PlanNodeBody = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  task: z.string().min(1),
  parentId: z.string().nullable(),
  waitFor: z.array(z.string()).optional(),
});

const CreateSwarmBody = z.object({
  nodes: z.array(PlanNodeBody).min(1),
  spawnDepth: z.number().int().positive(),
  maxAgents: z.number().int().positive(),
});

export const swarmsRoutes = new Elysia({ prefix: "/swarms" })
  .post("/plan", async ({ body }) => {
    const { prompt } = parseBody(PlanBody, body);
    return planSwarm(prompt);
  })

  .post("/", ({ body, set }) => {
    const plan = parseBody(CreateSwarmBody, body);
    const result = createSwarm(plan);
    set.status = 202;
    return result;
  });
