/**
 * Crash recovery: start K agents on a turn that is guaranteed to be in flight, hard-kill alineod,
 * restart it, and check each agent finishes exactly once with the right answer.
 *
 * Usage: bun src/crash.ts [--agents 4] [--mode kill|stop] [--out results]
 *   kill = `docker kill` (SIGKILL, a real crash); stop = `docker stop` (SIGTERM, graceful).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteRun,
  agentSpec,
  getRun,
  startRun,
  waitHealthy,
  waitResult,
  type AgentSummary,
} from "./alineod.ts";
import { collectManifest } from "./manifest.ts";
import { readEvents } from "./trace.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const K = Number(arg("agents", "4"));
const mode = arg("mode", "kill");
const out = arg("out", "results");
const container = process.env.ALINEOD_CONTAINER ?? "alineo-alineod";
const sh = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

const sleepSeconds = 120;
// The command appends one line to /tmp/starts.txt every time it starts. After recovery the line count is the number
// of times the side effect actually ran: 1 means the interrupted work was not repeated, 2+ means it was.
const prompt = (token: string) =>
  `Use your bash tool to run exactly this ONE command, once: echo run >> /tmp/starts.txt; sleep ${sleepSeconds}; echo ${token} > /tmp/bench-out.txt . ` +
  `After it finishes, run: cat /tmp/bench-out.txt . Then reply with exactly the contents of that file and nothing else.`;

/** Times the marker command started in this sandbox (the side effect ran this many times). */
function executionsIn(sandboxId: string | null): number | null {
  if (!sandboxId) return null;
  const name = `sandbox-${sandboxId}`;
  try {
    execFileSync("docker", ["unpause", name], { stdio: "ignore", timeout: 15_000 });
  } catch {
    // already running
  }
  try {
    const n = execFileSync("docker", ["exec", name, "bash", "-c", "grep -c run /tmp/starts.txt || true"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    return Number(n);
  } catch {
    return null;
  }
}

/** The ordered, de-duplicated names of turn/resume-related events for one agent after the restart. */
async function resumeEventNames(runId: string, agentId: string): Promise<string[]> {
  const evs = await readEvents(runId);
  const names: string[] = [];
  for (const e of evs) {
    if (e.data["agentId"] !== agentId) continue;
    if (!/turn|resum|reattach|interrupt|restor|rehydrat|prompt|replay/i.test(e.event)) continue;
    if (names[names.length - 1] !== e.event) names.push(e.event);
  }
  return names;
}

interface Row {
  /** How many times the marker command started (1 = the interrupted work was not repeated). */
  executions: number | null;
  resumeEvents: string[];
  agentId: string;
  token: string;
  stateBefore: string;
  sandboxBefore: string | null;
  stateAfter: string;
  sandboxAfter: string | null;
  outcome: string | null;
  correct: boolean;
  agentsInRun: number;
  detail: string;
}

const manifest = collectManifest({ scenario: "crash-recovery", agents: K, mode });
const runs: { runId: string; agentId: string; token: string }[] = [];

try {
  for (let i = 0; i < K; i++) {
    const token = `TOKEN-${Date.now()}-${i}`;
    const run = await startRun(agentSpec({ name: `bench-crash-${i}` }), prompt(token));
    runs.push({ runId: run.runId, agentId: run.rootAgentId, token });
  }
  console.log(`started ${K} runs; waiting for all to have a live sandbox mid-turn`);

  // Wait until every agent has either gone live or failed to start. Start failures (e.g. a snapshot
  // timeout under load) are a scale finding in their own right, so count them instead of hanging.
  const t0 = Date.now();
  let startFailures = 0;
  for (;;) {
    const trees = await Promise.all(runs.map((r) => getRun(r.runId)));
    const agents = trees.map((t) => t.agents[0]);
    const live = agents.filter((a) => a?.sandboxId && a.state === "running").length;
    startFailures = agents.filter((a) => a && (a.state === "failed" || a.outcome === "failed")).length;
    if (live > 0 && live + startFailures === K) break;
    if (Date.now() - t0 > 900_000) throw new Error("agents never all went live or failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`live=${K - startFailures} startFailures=${startFailures}`);

  const before = new Map<string, AgentSummary>();
  const liveRuns = [];
  for (const r of runs) {
    const a = (await getRun(r.runId)).agents[0]!;
    before.set(r.agentId, a);
    if (a.state === "running") liveRuns.push(r);
  }
  console.log("before crash:", [...before.values()].map((a) => a.state).join(","));

  const tKill = Date.now();
  if (mode === "kill") sh(["kill", container]);
  else sh(["stop", container]);
  console.log(`${mode} -> alineod down`);
  sh(["start", container]);
  const healthyMs = await waitHealthy();
  const downMs = Date.now() - tKill;
  console.log(`alineod healthy after ${healthyMs}ms (kill->healthy ${downMs}ms)`);

  const rows: Row[] = [];
  const failureEvents: Record<string, unknown> = {};
  const tRecover = Date.now();
  const settled = await Promise.all(
    liveRuns.map(async (r) => ({ r, res: await waitResult(r.agentId, 900_000) })),
  );
  const finishMs = Date.now() - tRecover;
  for (const { r, res } of settled) {
    const tree = await getRun(r.runId);
    const a = tree.agents.find((x) => x.agentId === r.agentId)!;
    const b = before.get(r.agentId)!;
    if (res.outcome !== "success") {
      failureEvents[r.agentId] = res.result?.slice(0, 500) ?? null;
    }
    rows.push({
      executions: executionsIn(a.sandboxId),
      resumeEvents: await resumeEventNames(r.runId, r.agentId),
      agentId: r.agentId,
      token: r.token,
      stateBefore: b.state,
      sandboxBefore: b.sandboxId,
      stateAfter: a.state,
      sandboxAfter: a.sandboxId,
      outcome: res.outcome,
      correct: (res.result ?? "").includes(r.token),
      agentsInRun: tree.agents.length,
      detail: (res.result ?? "").slice(0, 300),
    });
  }

  const summary = {
    mode,
    agents: K,
    startFailures,
    killToHealthyMs: downMs,
    healthyWaitMs: healthyMs,
    recoverToAllSettledMs: finishMs,
    succeeded: rows.filter((r) => r.outcome === "success").length,
    correct: rows.filter((r) => r.correct).length,
    inFlightAtKill: [...before.values()].filter((a) => a.state === "running").length,
    sameSandbox: rows.filter((r) => r.sandboxBefore && r.sandboxBefore === r.sandboxAfter).length,
    duplicatedAgents: rows.filter((r) => r.agentsInRun !== 1).length,
    ranExactlyOnce: rows.filter((r) => r.executions === 1).length,
    ranMoreThanOnce: rows.filter((r) => (r.executions ?? 0) > 1).length,
    resumeSequences: [...new Set(rows.map((r) => r.resumeEvents.join(" > ")))],
    failureEvents,
    rows,
  };
  const dir = join(out, `crash-${mode}-${manifest.runId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
  console.table(rows);
  try {
    writeFileSync(join(dir, "alineod.log"), sh(["logs", "--tail", "400", container]));
  } catch {
    // logs are advisory
  }
  console.log(`wrote ${dir}`);
} finally {
  for (const r of runs) await deleteRun(r.runId);
}
