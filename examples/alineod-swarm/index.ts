/**
 * Demonstrates driving an agent swarm through alineod's HTTP + SSE API:
 *
 *   1. create a run (root agent)          POST /runs
 *   2. watch the whole swarm live         GET  /runs/:runId/events
 *   3. fan out to three workers           POST /runs/:runId/agents
 *   4. pause and resume one worker        POST /agents/:id/pause | /resume
 *   5. steer another one mid-turn         POST /agents/:id/steer
 *   6. gather with waitFor                POST /runs/:runId/agents  { waitFor }
 *   7. collect the result                 GET  /agents/:id/result?wait=
 *   8. tear the run down                  DELETE /runs/:runId
 *
 * No SDK needed — alineod's interface is plain HTTP. Needs a running alineod (see README) with
 * NVIDIA_API_KEY in *its* environment.
 */
const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";

function agentSpec(name: string, budget: { spawnDepth?: number; maxAgents?: number } = {}) {
  return {
    name,
    harness: "pi",
    provider: "nvidia",
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    // Resolved from alineod's own environment — the key never travels in the request.
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
    ...budget,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- a tiny untyped client for the demo
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (res.status >= 400)
    throw new Error(`${method} ${path} → ${res.status}: ${parsed?.error ?? text}`);
  return parsed;
}

/** Wait until an agent's sandbox exists — required before it can be a spawn parent, paused, or steered. */
async function waitLive(agentId: string): Promise<void> {
  for (;;) {
    const agent = await api("GET", `/agents/${agentId}`);
    if (agent.sandboxId) return;
    if (agent.outcome) throw new Error(`${agent.specName} ended before starting: ${agent.outcome}`);
    await Bun.sleep(2_000);
  }
}

/** Long-poll until the agent's result settles. */
async function waitResult(agentId: string): Promise<string> {
  for (;;) {
    const res = await fetch(`${BASE}/agents/${agentId}/result?wait=120`);
    const body = await res.json();
    if (res.status === 200) return body.result ?? "";
  }
}

/** Print lifecycle events for the whole run as they happen. */
async function watch(runId: string, signal: AbortSignal): Promise<void> {
  const names = new Map<string, string>();
  const res = await fetch(`${BASE}/runs/${runId}/events`, { signal });
  if (!res.body) throw new Error(`GET /runs/${runId}/events → ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!event || !data) continue;
        const d = JSON.parse(data);
        if (event === "agent_spawned") names.set(d.agentId, d.specName);
        const who = names.get(d.agentId) ?? "run";
        if (event === "agent_state_changed")
          console.log(`  · ${who}: ${d.from} → ${d.to}${d.reason ? ` (${d.reason})` : ""}`);
        if (event === "agent_steered") console.log(`  · ${who}: steered`);
        if (event === "tool_start") console.log(`  · ${who}: running ${d.toolName}`);
        if (event === "agent_ended") console.log(`  · ${who}: ended (${d.outcome})`);
      }
    }
  } catch {
    // aborted at the end of the demo
  }
}

// ── 1. create a run ─────────────────────────────────────────────────────────
const run = await api("POST", "/runs", {
  spec: agentSpec("coordinator", { spawnDepth: 1, maxAgents: 5 }),
});
console.log(`run ${run.runId} — root ${run.rootAgentId}`);

// ── 2. watch it ─────────────────────────────────────────────────────────────
const stop = new AbortController();
const watching = watch(run.runId, stop.signal);

await waitLive(run.rootAgentId);
console.log("root is live\n");

// ── 3. fan out ──────────────────────────────────────────────────────────────
const topics = ["the ocean", "mountains", "the desert"];
const workers: string[] = [];
for (const topic of topics) {
  const child = await api("POST", `/runs/${run.runId}/agents`, {
    parentAgentId: run.rootAgentId,
    spec: agentSpec(`worker-${topic.split(" ").at(-1)}`),
    prompt: `Write one haiku (5-7-5) about ${topic}. Output only the three lines.`,
    idempotencyKey: `haiku-${topic}`, // safe to retry this request
  });
  workers.push(child.agentId);
}
await Promise.all(workers.map(waitLive));

// ── 4. pause and resume one worker ──────────────────────────────────────────
await api("POST", `/agents/${workers[1]}/pause`);
console.log(`\nworker-mountains is ${(await api("GET", `/agents/${workers[1]}`)).state}`);
await Bun.sleep(3_000);
await api("POST", `/agents/${workers[1]}/resume`);
console.log(`worker-mountains is ${(await api("GET", `/agents/${workers[1]}`)).state}\n`);

// ── 5. steer another ────────────────────────────────────────────────────────
// Lands after the worker's current tool calls finish, before its next model call.
await api("POST", `/agents/${workers[2]}/steer`, {
  message: "Make the desert haiku about the desert at night.",
});

// ── 6. gather ───────────────────────────────────────────────────────────────
const gather = await api("POST", `/runs/${run.runId}/agents`, {
  parentAgentId: run.rootAgentId,
  spec: agentSpec("gather"),
  waitFor: workers,
  prompt:
    "Read /inputs.json and the three haiku files it lists (ocean, mountains, desert, in that order). " +
    "Output a poem titled 'Three Landscapes' with the three haikus as stanzas. Output only the poem.",
});
console.log(`gather is ${gather.state} until all three workers finish`);

// ── 7. collect ──────────────────────────────────────────────────────────────
const poem = await waitResult(gather.agentId);
console.log(`\n${poem}\n`);

const tree = await api("GET", `/runs/${run.runId}`);
for (const a of tree.agents) {
  console.log(
    `${"  ".repeat(a.depth)}${a.specName.padEnd(18)} ${a.state.padEnd(8)} ${a.outcome ?? ""}`,
  );
}

// ── 8. tear down ────────────────────────────────────────────────────────────
await api("DELETE", `/runs/${run.runId}`);
stop.abort();
await watching;
