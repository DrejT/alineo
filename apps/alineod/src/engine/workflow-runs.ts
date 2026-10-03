/**
 * Workflow run registry on top of `@alineo-labs/workflow`, which has none of its own (confirmed:
 * `WorkflowResult` is just `{stdout, vars}` — see PLAN.md §8 for the scope this was built to).
 *
 * Each step is one `sb.exec()` queued in order inside a single `.sandbox()` stage; status is
 * tracked via `SandboxOptions.hooks`, which fire in queued order for a plain sequential `fn` —
 * no change to the workflow package itself, just observing what it already reports.
 *
 * Honesty flag (PLAN.md §9): "retry" re-runs the whole workflow in a fresh sandbox, not just the
 * failed step onward — `@alineo-labs/workflow`'s lazy, all-at-once-flushed queue has no primitive
 * for resuming a partially-flushed stage, and this doesn't invent one.
 */
import { workflow } from "@alineo-labs/workflow";
import { client } from "./sandbox-registry";
import { defaultResources } from "./swarm-planner";
import { HttpError } from "./errors";
import { errorMessage } from "../util";
import {
  createWorkflowRun,
  setWorkflowSandbox,
  finishWorkflowRun,
  startStep,
  finishStep,
  getWorkflowRun,
  getWorkflowSteps,
  listWorkflowRuns,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from "../state/workflows";

export interface WorkflowStepInput {
  name: string;
  run: string;
}

export interface CreateWorkflowBody {
  name: string;
  steps: WorkflowStepInput[];
  resources?: { cpu: string; memory: string; gpu?: string };
}

function newWorkflowRunId(): string {
  return `wf_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function startWorkflow(body: CreateWorkflowBody): { id: string } {
  if (body.steps.length === 0) throw new HttpError(400, "at least one step is required");
  const id = newWorkflowRunId();
  createWorkflowRun(id, body.name, body.steps);
  void execute(id, body);
  return { id };
}

async function execute(id: string, body: CreateWorkflowBody): Promise<void> {
  let index = 0;
  try {
    const result = await workflow(client)
      .sandbox(
        {
          image: "node:22",
          resources: body.resources ?? defaultResources(),
          hooks: {
            onSandboxCreated: (sandboxId) => setWorkflowSandbox(id, sandboxId),
            onExecStart: () => startStep(id, index),
            onExecComplete: (_sandboxId, _seq, result) => {
              finishStep(
                id,
                index,
                result.exitCode === 0 ? "done" : "failed",
                result.exitCode,
                result.stdout,
                result.stderr,
              );
              index++;
            },
          },
        },
        (sb) => {
          for (const step of body.steps) sb.exec(step.run, { strict: false });
        },
      )
      .result();
    void result;
    finishWorkflowRun(id, "done");
  } catch (err) {
    finishWorkflowRun(id, "failed", errorMessage(err));
  }
}

export function retryWorkflow(id: string): { id: string } {
  const run = getWorkflowRun(id);
  if (!run) throw new HttpError(404, `no workflow run ${id}`);
  const steps = getWorkflowSteps(id);
  return startWorkflow({ name: run.name, steps: steps.map((s) => ({ name: s.name, run: s.run })) });
}

export function getWorkflow(id: string): { run: WorkflowRunRow; steps: WorkflowStepRow[] } {
  const run = getWorkflowRun(id);
  if (!run) throw new HttpError(404, `no workflow run ${id}`);
  return { run, steps: getWorkflowSteps(id) };
}

export function listWorkflows(): WorkflowRunRow[] {
  return listWorkflowRuns();
}
