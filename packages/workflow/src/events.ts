/**
 * Events a workflow reports through `workflow(client, { onEvent })`.
 *
 * The names are the `workflow.*` and `step.*` definitions in `@alineo-labs/schema`. A step is
 * one leaf op (`exec`, `readFileBytes`, `setCredential`, ...). `retry`, `when` and `forEach`
 * are not steps themselves: the ops inside them are.
 *
 * Events never carry command text, file contents, credential values or `vars`, so a listener
 * can store them as a run record without storing secrets.
 */
export type WorkflowEvent =
  | { type: "workflow.started" }
  | { type: "workflow.completed"; durationMs: number }
  | { type: "workflow.failed"; durationMs: number; error: string }
  | { type: "step.started"; index: number; name: string; kind: string }
  | {
      type: "step.completed";
      index: number;
      name: string;
      kind: string;
      durationMs: number;
      /** Exit code, for `exec` and `execCode` steps. */
      exitCode?: number;
    }
  | {
      type: "step.failed";
      index: number;
      name: string;
      kind: string;
      durationMs: number;
      error: string;
    };

/** Options for `workflow(client, options)`. */
export interface WorkflowOptions {
  /**
   * Called synchronously for every workflow and step event. A listener that throws does not
   * fail the workflow.
   */
  onEvent?: (event: WorkflowEvent) => void;
}
