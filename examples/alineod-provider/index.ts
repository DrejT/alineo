/**
 * Demonstrates that alineod runs on the configured sandbox provider and says which:
 *   1. create a run               POST /runs
 *   2. read the agent's provider  GET  /agents/:id          -> provider
 *   3. read it in the run tree    GET  /runs/:runId         -> agents[].provider
 *   4. tear the run down          DELETE /runs/:runId
 *
 * Needs: a running alineod (see README) with NVIDIA_API_KEY in *its* environment.
 * The agent gets a sandbox but is never prompted, so this uses no model quota.
 */
const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";

const spec = {
  name: "alineod-provider",
  harness: { id: "pi", version: "1.2.0" },
  model: { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b" },
  env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

// oxlint-disable-next-line typescript/no-explicit-any -- a tiny untyped client for the demo
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${parsed?.error}`);
  return parsed;
}

console.log("── 1. create a run ──────────────────────────────────────────");
const run = await api("POST", "/runs", { spec });
console.log(`run ${run.runId}, root agent ${run.rootAgentId}`);

try {
  console.log("\n── 2. wait for the sandbox, read the agent ──────────────────");
  let agent = await api("GET", `/agents/${run.rootAgentId}`);
  while (!agent.sandboxId) {
    if (agent.outcome) throw new Error(`agent ended before it started: ${agent.outcome}`);
    await Bun.sleep(3_000);
    agent = await api("GET", `/agents/${run.rootAgentId}`);
  }
  console.log(`sandbox ${agent.sandboxId} on provider "${agent.provider}"`);

  console.log("\n── 3. the run tree ──────────────────────────────────────────");
  const tree = await api("GET", `/runs/${run.runId}`);
  for (const a of tree.agents) console.log(`${a.specName}: provider "${a.provider}"`);
} finally {
  console.log("\n── 4. tear down ─────────────────────────────────────────────");
  await api("DELETE", `/runs/${run.runId}`);
  console.log("run closed");
}
