/**
 * Swarm runs. A run is a goal plus a master agent. The master works in its own sandbox and can
 * spawn more agent sandboxes, each with its own task, through a small `swarm` command that is
 * installed inside every agent sandbox. The command calls back to this server with a token that
 * is scoped to one run, so an agent can only act on the run it belongs to.
 */
import { db } from "./db";
import { getSandbox, spawnSandbox, terminateSandbox, type SandboxRecord } from "./sandboxes";
import { getHandle, peekAgent, AGENTS_ENABLED, MAX_SANDBOXES } from "./runtime";
import { promptAgent, recordEvent } from "./agents";
import { resolveModel } from "./models";
import { steerAgent } from "./steer";

export const RUN_DEFAULT_AGENTS = Number(process.env.ALINEO_UI_RUN_AGENTS ?? 5);
export const RUN_MAX_DEPTH = Number(process.env.ALINEO_UI_RUN_DEPTH ?? 3);
/** What a sandbox calls to reach this server. A sandbox cannot use "localhost": that is itself. */
const PORT = process.env.PORT ?? "4600";
const CALLBACK_URL = process.env.ALINEO_UI_CALLBACK_URL ?? `http://172.17.0.1:${PORT}`;

export interface RunNode {
  id: string; parentId: string | null; role: string; task: string; status: SandboxRecord["status"];
  state: SandboxRecord["state"]; result: string; depth: number; model: string; startedAt: number; browser: boolean;
}
export interface Run {
  id: string; goal: string; status: "starting" | "running" | "done" | "failed" | "stopped"; model: string;
  maxAgents: number; masterId: string | null; summary: string; createdAt: number; finishedAt: number | null;
  nodes: RunNode[];
}

// ---------------------------------------------------------------------------
// The `swarm` command that runs inside each agent sandbox.
// ---------------------------------------------------------------------------
const SWARM_CLI = `#!/usr/bin/env node
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("/etc/swarm.json", "utf8"));
async function call(path, body) {
  const res = await fetch(cfg.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.token }, body: JSON.stringify(body || {}) });
  const text = await res.text();
  if (!res.ok) { console.error(text); process.exit(1); }
  console.log(text);
}
const [cmd, a, b] = process.argv.slice(2);
const usage = () => { console.error('usage: swarm spawn "<role>" "<task>" | swarm status | swarm wait <id> [seconds] | swarm send <id> "<message>"'); process.exit(2); };
if (cmd === "spawn" && a && b) call("/api/swarm/spawn", { role: a, task: b });
else if (cmd === "status") call("/api/swarm/status");
else if (cmd === "wait" && a) call("/api/swarm/wait", { id: a, seconds: b ? Number(b) : 45 });
else if (cmd === "send" && a && b) call("/api/swarm/send", { id: a, message: b });
else usage();
`;

async function installSwarm(userId: string, runId: string, sandboxId: string): Promise<void> {
  const token = "swm_" + crypto.randomUUID().replaceAll("-", "");
  db.prepare(`INSERT INTO swarm_tokens (token, user_id, run_id, sandbox_id) VALUES (?, ?, ?, ?)`).run(token, userId, runId, sandboxId);
  const sb = await getHandle(sandboxId);
  await sb.writeFile("/etc/swarm.json", JSON.stringify({ url: CALLBACK_URL, token, sandbox: sandboxId }));
  await sb.writeFile("/usr/local/bin/swarm", SWARM_CLI);
  await sb.exec("chmod +x /usr/local/bin/swarm");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function masterPrompt(goal: string, maxAgents: number): string {
  return `You are the master agent of a swarm. Your goal:

${goal}

You work inside your own Linux sandbox (bash, file tools, Python 3 and Node are available, and you can install packages). You also have a real web browser, through the tools browser_open, browser_snapshot, browser_click, browser_fill and browser_screenshot. Use it to read live web pages and to check things you cannot know offline. A person can watch your browser live. You can also create more agents. Each one gets its own sandbox and its own task. Use the \`swarm\` command in bash:

  swarm spawn "<role>" "<task>"   create an agent in a new sandbox and start it on the task. Prints its id.
  swarm status                    show every agent in this run, its state and its last result
  swarm wait <id> [seconds]       wait for that agent to finish (up to 45 seconds), then print its result
  swarm send <id> "<message>"     give an agent a new message

Rules:
- The run may hold at most ${maxAgents} agents in total, you included. Spawn only when the work splits into parts that can run side by side. For a small goal, do it yourself.
- Sandboxes do not share files. An agent gives its work back as its final reply, so tell each one exactly what to put in it.
- Write each task so the agent can act on it alone: say what to do, what to produce, and what to report.
- Spawn the agents you need first, then wait for each one. If \`swarm wait\` says an agent is still working, run it again.
- Check the results and fix gaps yourself or send a new message to the agent.
- Finish with a short final reply: what you did, what the agents found, and the answer to the goal. Do not finish while an agent you need is still working.`;
}

function workerPrompt(role: string, task: string): string {
  return `You are "${role}", an agent in a swarm. Your parent gave you this task:

${task}

Work in your own sandbox. You have a real web browser through the tools browser_open, browser_snapshot, browser_click, browser_fill and browser_screenshot, and a person can watch it live. Use it when the task needs a live web page. Finish the task yourself. Your final reply is sent back to your parent, so make it complete and short: what you did, the key results, and any file paths or numbers they need. If the task has parts that can run side by side you may create agents with \`swarm spawn "<role>" "<task>"\`, then use \`swarm wait <id>\`, but only when it clearly helps.`;
}

// ---------------------------------------------------------------------------
// Running turns in the background
// ---------------------------------------------------------------------------
/** Spawns in progress per run, so two agents spawning at once cannot pass the limit together. */
const reserved = new Map<string, number>();

// A run cannot outlive the server process that drives it.
db.run(`UPDATE runs SET status = 'failed', summary = 'The server restarted during this run.', finished_at = ${Date.now()} WHERE status IN ('starting', 'running')`);
db.run(`UPDATE sandboxes SET state = 'idle' WHERE state = 'working'`);
// Containers of a run the restart cut short, and of runs that ended before it, would otherwise stay up until their timeout.
void (async () => {
  const rows = db.query(`SELECT DISTINCT r.user_id AS u, r.id AS id FROM runs r JOIN sandboxes s ON s.run_id = r.id WHERE s.status != 'terminated'`).all() as { u: string; id: string }[];
  for (const r of rows) await removeContainers(r.u, r.id);
})();

const NUDGE = "You stopped without a final reply. If the task is not finished, carry on and finish it. Then end with a short final reply that states the result.";

/**
 * Send a prompt to an agent and read the stream to its end. The frames are saved by promptAgent.
 * A model sometimes ends a turn with no text after using tools. Ask it to finish, up to twice.
 */
async function driveTurn(userId: string, sandboxId: string, message: string): Promise<string> {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    let reply = "";
    for await (const f of promptAgent(userId, sandboxId, i === 0 ? message : NUDGE, { keepWorking: i < attempts - 1 })) {
      if (f.type === "text") reply += f.text;
    }
    if (reply.trim()) return reply;
  }
  return "";
}

function nodesOf(userId: string, runId: string): RunNode[] {
  const rows = db.query(`SELECT id FROM sandboxes WHERE user_id = ? AND run_id = ? ORDER BY uptime_start ASC`).all(userId, runId) as { id: string }[];
  return rows.map((r) => getSandbox(userId, r.id)!).filter(Boolean).map((s) => ({
    id: s.id, parentId: s.parentId, role: s.role, task: s.task, status: s.status, state: s.state,
    result: s.result, depth: s.depth, model: s.modelProvider, startedAt: s.uptimeStart, browser: s.browser,
  }));
}

function toRun(row: any, userId: string): Run {
  return {
    id: row.id, goal: row.goal, status: row.status, model: row.model, maxAgents: row.max_agents, masterId: row.master_id,
    summary: row.summary, createdAt: row.created_at, finishedAt: row.finished_at, nodes: nodesOf(userId, row.id),
  };
}

export function listRuns(userId: string): Run[] {
  const rows = db.query(`SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(userId) as any[];
  return rows.map((r) => toRun(r, userId));
}

export function getRun(userId: string, runId: string): Run | null {
  const row = db.query(`SELECT * FROM runs WHERE user_id = ? AND id = ?`).get(userId, runId);
  return row ? toRun(row, userId) : null;
}

/** How long a finished run keeps its containers, so you can open them and read the files. */
const KEEP_MINUTES = Number(process.env.ALINEO_UI_RUN_KEEP_MINUTES ?? 10);

function finish(userId: string, runId: string, status: Run["status"], summary: string): void {
  db.prepare(`UPDATE runs SET status = ?, summary = ?, finished_at = ? WHERE id = ? AND status IN ('starting', 'running')`)
    .run(status, summary.slice(0, 4000), Date.now(), runId);
  // Containers cost memory. Remove them after a grace period instead of leaving them until the sandbox timeout.
  const timer = setTimeout(() => { void removeContainers(userId, runId); }, KEEP_MINUTES * 60_000);
  timer.unref?.();
}

async function removeContainers(userId: string, runId: string): Promise<void> {
  const run = getRun(userId, runId);
  if (!run) return;
  for (const n of run.nodes) {
    if (n.status === "terminated") continue;
    await peekAgent(n.id)?.agent.abort().catch(() => {});
    await terminateSandbox(userId, n.id).catch(() => {});
  }
  db.prepare(`DELETE FROM swarm_tokens WHERE run_id = ?`).run(runId);
}

/** Start a run. Returns at once; the master sandbox starts in the background. */
export function startRun(userId: string, input: { goal: string; modelProvider?: string; maxAgents?: number }): Run {
  if (!AGENTS_ENABLED) throw new Error("Agents are off: NVIDIA_API_KEY is not set on the server.");
  const goal = input.goal.trim();
  if (!goal) throw new Error("Missing goal");
  if (goal.length > 4000) throw new Error("The goal is too long (4000 characters max)");
  const maxAgents = Math.min(Math.max(Math.floor(input.maxAgents ?? RUN_DEFAULT_AGENTS), 1), MAX_SANDBOXES);
  const model = resolveModel(input.modelProvider).id;
  const id = "run_" + crypto.randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO runs (id, user_id, goal, status, model, max_agents, created_at) VALUES (?, ?, ?, 'starting', ?, ?, ?)`)
    .run(id, userId, goal, model, maxAgents, Date.now());

  void (async () => {
    try {
      const master = await spawnSandbox(userId, { role: "master", modelProvider: model, runId: id, task: goal, agent: true, cpuLimitMilli: 1000, memLimitMi: 1536 });
      db.prepare(`UPDATE runs SET master_id = ?, status = 'running' WHERE id = ?`).run(master.id, id);
      await installSwarm(userId, id, master.id);
      const reply = await driveTurn(userId, master.id, masterPrompt(goal, maxAgents));
      const run = db.query(`SELECT status FROM runs WHERE id = ?`).get(id) as { status: string } | null;
      if (run?.status === "stopped") return;
      // The master's answer is its text after its last tool call, which promptAgent saved as its result.
      const answer = (getSandbox(userId, master.id)?.result || reply).trim();
      if (reply) finish(userId, id, "done", answer); else finish(userId, id, "failed", "The master agent ended without a reply.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish(userId, id, "failed", msg);
    }
  })();

  return getRun(userId, id)!;
}

/** Stop a run: abort every agent and delete every container in it. */
export async function stopRun(userId: string, runId: string): Promise<boolean> {
  const run = getRun(userId, runId);
  if (!run) return false;
  // A run that already ended keeps its result. Only a live run becomes "stopped".
  db.prepare(`UPDATE runs SET status = 'stopped', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('starting', 'running')`).run(Date.now(), runId);
  await removeContainers(userId, runId);
  db.prepare(`UPDATE sandboxes SET state = 'idle' WHERE run_id = ? AND state = 'working'`).run(runId);
  return true;
}

// ---------------------------------------------------------------------------
// The API the `swarm` command calls. Token auth, scoped to one run.
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function handleSwarm(req: Request, url: URL): Promise<Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const t = token ? db.query(`SELECT user_id, run_id, sandbox_id FROM swarm_tokens WHERE token = ?`).get(token) as { user_id: string; run_id: string; sandbox_id: string } | null : null;
  if (!t) return json({ error: "Invalid swarm token" }, 401);
  const userId = t.user_id;
  const run = getRun(userId, t.run_id);
  if (!run) return json({ error: "Run not found" }, 404);
  const body = await req.json().catch(() => ({} as Record<string, any>));
  const live = run.status === "running" || run.status === "starting";

  if (url.pathname === "/api/swarm/status") {
    return json({
      run: run.id, status: run.status, you: t.sandbox_id, maxAgents: run.maxAgents,
      agents: run.nodes.filter((n) => n.status !== "terminated").map((n) => ({
        id: n.id, role: n.role, parent: n.parentId, state: n.state, task: clip(n.task, 120), result: clip(n.result, 300),
      })),
    });
  }

  if (url.pathname === "/api/swarm/spawn") {
    if (!live) return json({ error: `The run is ${run.status}; no more agents can be spawned.` }, 409);
    const caller = getSandbox(userId, t.sandbox_id);
    if (!caller) return json({ error: "Caller not found" }, 404);
    const role = String(body.role ?? "").trim().slice(0, 60);
    const task = String(body.task ?? "").trim();
    if (!role || !task) return json({ error: "spawn needs a role and a task" }, 400);
    if (task.length > 6000) return json({ error: "The task is too long (6000 characters max)" }, 400);
    if (caller.depth + 1 > RUN_MAX_DEPTH) return json({ error: `The run allows ${RUN_MAX_DEPTH} levels of agents; this one cannot spawn more.` }, 409);
    const used = run.nodes.filter((n) => n.status !== "terminated").length + (reserved.get(run.id) ?? 0);
    if (used >= run.maxAgents) return json({ error: `The run is at its limit of ${run.maxAgents} agents.` }, 409);
    reserved.set(run.id, (reserved.get(run.id) ?? 0) + 1);
    try {
      const child = await spawnSandbox(userId, { role, parentId: caller.id, modelProvider: run.model, runId: run.id, task, agent: true, cpuLimitMilli: 1000, memLimitMi: 1536 });
      db.prepare(`UPDATE sandboxes SET state = 'working' WHERE id = ?`).run(child.id);
      await installSwarm(userId, run.id, child.id);
      void driveTurn(userId, child.id, workerPrompt(role, task));
      return json({ id: child.id, role, parent: caller.id, state: "working" });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      reserved.set(run.id, Math.max((reserved.get(run.id) ?? 1) - 1, 0));
    }
  }

  // The rest act on one agent of this run.
  const target = run.nodes.find((n) => n.id === String(body.id ?? ""));
  if (!target) return json({ error: "No such agent in this run" }, 404);

  if (url.pathname === "/api/swarm/wait") {
    const deadline = Date.now() + Math.min(Math.max(Number(body.seconds) || 45, 1), 50) * 1000;
    for (;;) {
      const n = getSandbox(userId, target.id);
      if (!n || n.state !== "working") return json({ id: target.id, state: n?.state ?? "gone", result: n?.result ?? "" });
      if (Date.now() >= deadline) return json({ id: target.id, state: "working", note: "Still working. Run swarm wait again." });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (url.pathname === "/api/swarm/send") {
    const message = String(body.message ?? "").trim();
    if (!message) return json({ error: "Missing message" }, 400);
    recordEvent(userId, target.id, "note", `Message from ${getSandbox(userId, t.sandbox_id)?.role ?? "an agent"}`);
    const r = await steerAgent(userId, target.id, message, "node", "followUp");
    return json(r.results[0] ?? { delivered: false });
  }

  return json({ error: "Not found" }, 404);
}
