import { deleteRun, agentSpec, getRun, startRun, waitResult } from "./alineod.ts";

const t0 = performance.now();
const run = await startRun(agentSpec({ name: "bench-smoke" }), "Reply with exactly: READY");
console.log("run", run.runId, "root", run.rootAgentId);
const res = await waitResult(run.rootAgentId, 900_000);
console.log(`settled in ${((performance.now() - t0) / 1000).toFixed(1)}s`, res);
console.log((await getRun(run.runId)).agents.map((a) => `${a.state}/${a.outcome}`));
await deleteRun(run.runId);
