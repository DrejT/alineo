/**
 * Workflow-engine events — `@alineo-labs/workflow`'s steps and saga compensation.
 *
 * Moved out of `packages/core`'s enum now rather than later. Leaving them there is the exact
 * defect this package exists to fix, and moving them costs nothing while everything else moves.
 *
 * Two names change meaning rather than spelling:
 *
 *   - `run_started` meant a workflow run here and a *swarm* run in alineod. The two are
 *     `workflow.started` and `run.started` now, and nothing has to guess from context.
 *   - `snapshot` is **dropped**. It recorded a sandbox checkpoint that the workflow engine
 *     happened to take — so it emits `sandbox.checkpoint_created`, the event that already
 *     describes it. `checkpoint` (the workflow's own resumption point) stays, as
 *     `step.checkpointed`.
 */
import { z } from "zod";
import { defineEvent } from "../define";

export const WorkflowStarted = defineEvent({
  type: "workflow.started",
  durable: true,
  version: 1,
  description: "A workflow run began, before any step executed. Was `run_started`.",
  schema: z.object({ runId: z.string().optional() }),
});

export const WorkflowCompleted = defineEvent({
  type: "workflow.completed",
  durable: true,
  version: 1,
  description: "Every step finished without error.",
  schema: z.object({}),
});

export const WorkflowFailed = defineEvent({
  type: "workflow.failed",
  durable: true,
  version: 1,
  description: "Rollback completed after a step failure.",
  schema: z.object({ error: z.string().optional() }),
});

export const StepStarted = defineEvent({
  type: "step.started",
  durable: true,
  version: 1,
  schema: z.object({ name: z.string().optional() }),
});

export const StepCompleted = defineEvent({
  type: "step.completed",
  durable: true,
  version: 1,
  schema: z.object({ output: z.unknown().optional() }),
});

export const StepFailed = defineEvent({
  type: "step.failed",
  durable: true,
  version: 1,
  schema: z.object({ error: z.string().optional() }),
});

export const StepRolledBack = defineEvent({
  type: "step.rolled_back",
  durable: true,
  version: 1,
  description: "A step's rollback handler completed during saga compensation.",
  schema: z.object({}),
});

export const StepCheckpointed = defineEvent({
  type: "step.checkpointed",
  durable: true,
  version: 1,
  description: "A durable resumption point, written after each successful step. Was `checkpoint`.",
  schema: z.object({ stepIndex: z.number().int().optional(), state: z.unknown().optional() }),
});
