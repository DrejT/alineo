import type { Sandbox } from "@alineo-labs/sandbox";
import type { Task } from "../load.ts";

export interface ProvisionOptions {
  image: string;
  cpu: string;
  memory: string;
}

/** Create a sandbox, run one command, close it. Phases: provision, firstExec, warmExec. */
export function provisionTask(client: Sandbox, o: ProvisionOptions): Task {
  return async (i) => {
    const t0 = performance.now();
    const sb = await client.sandbox({
      image: o.image,
      resources: { cpu: o.cpu, memory: o.memory },
      name: `bench-prov-${Date.now()}-${i}`,
    });
    try {
      const t1 = performance.now();
      await sb.exec("true");
      const t2 = performance.now();
      await sb.exec("true");
      const t3 = performance.now();
      return { provision: t1 - t0, firstExec: t2 - t1, warmExec: t3 - t2 };
    } finally {
      await sb.close();
    }
  };
}
