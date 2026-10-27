import { HARD_TASKS, splitOf, TASKS, type Task } from "./tasks.ts";
import { HARD2_TASKS } from "./tasks-more.ts";

export const ALL_TASKS: Task[] = [...TASKS, ...HARD_TASKS, ...HARD2_TASKS];

export type Suite = "easy" | "hard" | "hard2" | "all";

/** Tasks for a named suite, optionally restricted to the dev or test split. */
export function selectTasks(suite: Suite, split: "dev" | "test" | "all" = "all"): Task[] {
  const base =
    suite === "easy"
      ? TASKS
      : suite === "hard"
        ? HARD_TASKS
        : suite === "hard2"
          ? HARD2_TASKS
          : ALL_TASKS;
  return split === "all" ? base : base.filter((t) => splitOf(t.id) === split);
}
