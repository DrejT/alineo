/**
 * Demonstrates alineod's subtree controls and coordination primitives on a small tagline team:
 *
 *   coordinator (root)
 *   ├─ lead
 *   │  ├─ drafter-bold
 *   │  ├─ drafter-calm
 *   │  └─ drafter-slow        takes ~2 minutes
 *   ├─ judge                  waitFor { mode: "quorum", k: 2 } on the drafters
 *   └─ editor                 notifyOn [drafter-slow], keeps working meanwhile
 *
 *   1. build the tree                        POST /runs, POST /runs/:runId/agents
 *   2. pause and resume the lead's subtree   POST /agents/:id/pause | /resume  { scope: "subtree" }
 *   3. steer the subtree through its parent  POST /agents/:id/steer            { scope: "subtree" }
 *   4. quorum gather                         waitFor { agents, mode: "quorum", k: 2 }
 *   5. notifyOn                              spawn { notifyOn }, GET /agents/:id/inbox
 *   6. wait without spawning                 POST /runs/:runId/await, GET /agents/:id/await?scope=subtree
 *   7. stop the lead's subtree               POST /agents/:id/stop             { scope: "subtree" }
 *
 * No SDK needed — plain HTTP. Needs a running alineod (see README) with NVIDIA_API_KEY in *its*
 * environment.
 */
const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";

function agentSpec(name: string, budget: { spawnDepth?: number; maxAgents?: number } = {}) {
  return {
    name,
    harness: "pi",
    provider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
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

async function waitState(agentId: string, state: string): Promise<void> {
  while ((await api("GET", `/agents/${agentId}`)).state !== state) await Bun.sleep(1_000);
}

/** Long-poll until the agent's result settles. */
async function waitResult(agentId: string): Promise<string> {
  for (;;) {
    const res = await fetch(`${BASE}/agents/${agentId}/result?wait=120`);
    const body = await res.json();
    if (res.status === 200) return body.result ?? "";
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- untyped demo payloads
function printOps(label: string, res: any): void {
  const ops = res.results.map(
    (r: { agentId: string; outcome: string; reason?: string }) =>
      `${names.get(r.agentId)}=${r.outcome}${r.reason ? ` (${r.reason})` : ""}`,
  );
  console.log(`${label}: ${ops.join(", ")}`);
}

const names = new Map<string, string>();
async function spawn(parentAgentId: string, name: string, extra: object = {}): Promise<string> {
  const child = await api("POST", `/runs/${run.runId}/agents`, {
    parentAgentId,
    spec: agentSpec(name),
    ...extra,
  });
  names.set(child.agentId, name);
  return child.agentId;
}

const tagline = (tone: string) =>
  `Write one ${tone} tagline (under ten words) for a coffee shop that opens at 4am. ` +
  "Output only the tagline.";

// ── 1. build the tree ───────────────────────────────────────────────────────
const run = await api("POST", "/runs", {
  spec: agentSpec("coord-root", { spawnDepth: 2, maxAgents: 8 }),
});
names.set(run.rootAgentId, "coordinator");
console.log(`run ${run.runId} — root ${run.rootAgentId}`);
await waitLive(run.rootAgentId);

const lead = await spawn(run.rootAgentId, "coord-lead");
await waitLive(lead);
const slow = await spawn(lead, "coord-drafter-slow", {
  prompt:
    "Use your bash tool to run exactly: sleep 120\n" + `When it finishes: ${tagline("sleepy")}`,
});
const drafters = [
  await spawn(lead, "coord-drafter-bold", { prompt: tagline("bold") }),
  await spawn(lead, "coord-drafter-calm", { prompt: tagline("calm") }),
  slow,
];
await Promise.all(drafters.map(waitLive));
console.log("lead and three drafters are live\n");

// ── 2. pause and resume the lead's whole subtree ────────────────────────────
// Pause goes parents-first (nothing under a paused parent keeps running); resume children-first.
printOps("pause subtree", await api("POST", `/agents/${lead}/pause`, { scope: "subtree" }));
await Bun.sleep(5_000);
printOps("resume subtree", await api("POST", `/agents/${lead}/resume`, { scope: "subtree" }));

// ── 3. steer the subtree through its parent ─────────────────────────────────
// The lead gets one message with its children's roster, and decides what to tell them.
await api("POST", `/agents/${lead}/prompt`, {
  text:
    "Use your bash tool to run exactly: sleep 20\n" +
    "When it finishes, follow any operator instructions you received; if none, reply READY.",
});
await waitState(lead, "running");
const steer = await api("POST", `/agents/${lead}/steer`, {
  scope: "subtree",
  message:
    "Don't run any more commands. Reply with one line per sub-agent you manage: " +
    "its agent id and its state.",
});
console.log(`\nsteer subtree → lead (${steer.deliveredAs}), roster of ${steer.roster.length}`);
console.log(`lead replied:\n${await waitResult(lead)}\n`);

// ── 4. quorum gather ────────────────────────────────────────────────────────
// The judge starts once any two drafters succeed; the slow one keeps running.
const judge = await spawn(run.rootAgentId, "coord-judge", {
  waitFor: { agents: drafters, mode: "quorum", k: 2, deadlineSec: 600 },
  prompt:
    "Use your bash tool to run exactly: cat /inputs/*.txt\n" +
    "Then reply with only the tagline you like best, copied exactly. (/inputs.json lists the " +
    "files; its __wait entry names the drafters that were still pending.)",
});

// ── 5. notifyOn ─────────────────────────────────────────────────────────────
// The editor isn't blocked: it's told when the slow drafter finishes, whatever it's doing then.
const editor = await spawn(run.rootAgentId, "coord-editor", {
  notifyOn: [slow],
  prompt:
    "Use your bash tool to run exactly: sleep 150\n" +
    "Then, without running anything else, reply with only the quoted tagline from any " +
    '"[alineo] Update from agents you\'re watching" message in this conversation, or NONE.',
});

// ── 6. wait without spawning ────────────────────────────────────────────────
let all;
do {
  all = await api("POST", `/runs/${run.runId}/await`, {
    agents: drafters,
    mode: "all",
    wait: 120,
  });
} while (all.outcome === "pending");
console.log(`all drafters: ${all.outcome}`);

console.log(`judge:\n${await waitResult(judge)}\n`);
console.log(`editor:\n${await waitResult(editor)}`);
const inbox = await api("GET", `/agents/${editor}/inbox`);
for (const n of inbox.delivered)
  console.log(`  editor inbox: ${names.get(n.aboutAgentId)} ${n.outcome}, as ${n.deliveredAs}`);

const quiet = await api("GET", `/agents/${lead}/await?scope=subtree&wait=60`);
console.log(`\nlead's subtree quiescent: ${quiet.quiescent}`);

// ── 7. stop the lead's subtree, then tear the run down ──────────────────────
// Children-first. Finished agents keep their outcome; their sandboxes are released.
printOps("stop subtree", await api("POST", `/agents/${lead}/stop`, { scope: "subtree" }));

const tree = await api("GET", `/runs/${run.runId}`);
for (const a of tree.agents) {
  console.log(
    `${"  ".repeat(a.depth)}${(names.get(a.agentId) ?? a.specName).padEnd(20)} ${a.state.padEnd(8)} ${a.outcome ?? ""}`,
  );
}
await api("DELETE", `/runs/${run.runId}`);
