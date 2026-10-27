import type { Sandbox } from "@alineo-labs/sandbox";
import type { Task } from "../load.ts";
import type { ProvisionOptions } from "./provision.ts";

const MARKER = "/tmp/bench-marker";

/**
 * One parent sandbox with a marker file; each task forks a child from it and checks the child
 * sees the marker (correctness, not just speed). Phases: fork, verify.
 * Returns the task plus a cleanup that closes the parent.
 */
export async function forkTask(
  client: Sandbox,
  o: ProvisionOptions,
): Promise<{ task: Task; close: () => Promise<void> }> {
  const parent = await client.sandbox({
    image: o.image,
    resources: { cpu: o.cpu, memory: o.memory },
    name: `bench-fork-parent-${Date.now()}`,
  });
  const token = `t-${Date.now()}`;
  await parent.exec(`echo ${token} > ${MARKER}`);

  const task: Task = async () => {
    const t0 = performance.now();
    const child = await parent.fork("bench-child");
    try {
      const t1 = performance.now();
      const { stdout } = await child.exec(`cat ${MARKER}`);
      const t2 = performance.now();
      if (!stdout.includes(token)) {
        throw new Error("fork correctness: child is missing the parent's file");
      }
      return { fork: t1 - t0, verify: t2 - t1 };
    } finally {
      await child.close();
    }
  };
  return { task, close: () => parent.close() };
}
