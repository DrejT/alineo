/** Workflow run registry routes — see engine/workflow-runs.ts for what "retry" actually does. */
import { Elysia } from "elysia";
import { z } from "zod";
import { startWorkflow, retryWorkflow, getWorkflow, listWorkflows } from "../engine/workflow-runs";
import { parseBody } from "./http";

const CreateWorkflowBody = z.object({
  name: z.string().min(1),
  steps: z.array(z.object({ name: z.string().min(1), run: z.string().min(1) })).min(1),
  resources: z
    .object({ cpu: z.string().min(1), memory: z.string().min(1), gpu: z.string().optional() })
    .optional(),
});

export const workflowsRoutes = new Elysia({ prefix: "/workflows" })
  .post("/", ({ body, set }) => {
    set.status = 202;
    return startWorkflow(parseBody(CreateWorkflowBody, body));
  })

  .get("/", () => ({ runs: listWorkflows() }))

  .get("/:id", ({ params }) => getWorkflow(params.id))

  .post("/:id/retry", ({ params, set }) => {
    set.status = 202;
    return retryWorkflow(params.id);
  });
