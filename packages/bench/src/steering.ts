/**
 * Steering suite: pause, resume, steer and stop a real agent mid-turn, and check by code (files in the sandbox,
 * container state, the daemon's replies) that each control did what it promises.
 *
 * Scenarios: steer a running turn to a new instruction; pause then resume and finish the original work; steer while
 * paused (must be accepted promptly, then applied on resume); stop a long turn.
 *
 * Every control call records its raw status and body in the check detail. v1 of this suite assumed response shapes
 * the daemon does not use (it answers 202 and reports state changes through the agent's `state`), which made working
 * controls look broken; checks here judge the observable effect instead.
 *
 * Usage: bun src/steering.ts [--repeats 1] [--out results]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpec, call, deleteRun, getRun, startRun, waitResult } from "./alineod.ts";
import { assertProviderBudget, ProviderCapReached } from "./budget.ts";
import { collectManifest } from "./manifest.ts";
import { wilson } from "./metrics.ts";
import { isPaused, sandboxExec, sleep } from "./sandbox-exec.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
interface ScenarioResult {
  scenario: string;
  repeat: number;
  checks: Check[];
  passed: boolean;
  ms: number;
  error?: string;
}

const short = (x: unknown) => JSON.stringify(x)?.slice(0, 160);
const ok2xx = (s: number) => s >= 200 && s < 300;
const TERMINAL = ["stopped", "done", "failed", "aborted"];

const spec = (name: string) => agentSpec({ name, extra: { setup: [{ name: "dirs", run: "mkdir -p /tmp/work" }] } });
const agentState = async (agentId: string) => (await call<{ state: string; outcome: string | null }>("GET", `/agents/${agentId}`)).body?.state;

/** Poll until `cond` holds or `ms` elapses; returns whether it held. */
async function until(cond: () => boolean | Promise<boolean>, ms: number, stepMs = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

const containerExists = (sandboxId: string) => {
  try {
    execFileSync("docker", ["inspect", "-f", "{{.State.Status}}", `sandbox-${sandboxId}`], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
};

async function startLive(name: string, prompt: string) {
  const run = await startRun(spec(name), prompt);
  let sandboxId: string | null = null;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const a = (await getRun(run.runId)).agents[0];
    if (a?.sandboxId && a.state === "running") {
      sandboxId = a.sandboxId;
      break;
    }
    if (a && (a.state === "failed" || a.outcome === "failed")) throw new Error("agent failed to start");
    await sleep(1500);
  }
  if (!sandboxId) throw new Error("agent never went live");
  await sleep(10_000); // let the first tool call begin
  return { run, agentId: run.rootAgentId, sandboxId };
}

async function steerRunningTurn(): Promise<Check[]> {
  const { run, agentId, sandboxId } = await startLive(
    `steer-${Date.now()}`,
    "Use your bash tool to run exactly: sleep 60; echo A > /tmp/work/a.txt . After it finishes, reply with exactly DONE-A.",
  );
  try {
    const t0 = Date.now();
    const s = await call<unknown>("POST", `/agents/${agentId}/steer`, {
      message: "Change of plan: do NOT wait for anything. Immediately run exactly: echo B > /tmp/work/b.txt . Then reply with exactly DONE-B.",
      scope: "agent",
    });
    const res = await waitResult(agentId, 600_000);
    const b = sandboxExec(sandboxId, "cat /tmp/work/b.txt 2>/dev/null");
    return [
      { name: "steer accepted while the turn was running", pass: ok2xx(s.status), detail: `HTTP ${s.status} ${short(s.body)}` },
      { name: "agent adopted the new instruction (b.txt written)", pass: b === "B", detail: `b.txt=${JSON.stringify(b)}` },
      { name: "final message follows the new instruction (DONE-B)", pass: /DONE-B/.test(res.result ?? ""), detail: (res.result ?? "").slice(0, 80) },
      { name: "turn finished successfully", pass: res.outcome === "success", detail: `${res.outcome} after ${((Date.now() - t0) / 1000).toFixed(0)}s` },
    ];
  } finally {
    await deleteRun(run.runId);
  }
}

async function pauseResume(): Promise<Check[]> {
  const { run, agentId, sandboxId } = await startLive(
    `pause-${Date.now()}`,
    "Use your bash tool to run exactly: sleep 40; echo done > /tmp/work/p.txt . After it finishes, reply with exactly OK.",
  );
  try {
    const p = await call<unknown>("POST", `/agents/${agentId}/pause`, { scope: "agent" });
    const statePaused = await until(async () => (await agentState(agentId)) === "paused", 20_000);
    const frozen = await until(() => isPaused(sandboxId), 20_000);
    // Hold the pause longer than the remaining sleep: a frozen process must not make progress.
    await sleep(45_000);
    const stillFrozen = isPaused(sandboxId);
    // If the container is not frozen any more, did the 40 s sleep finish while the agent was supposedly paused?
    const progressedWhilePaused = !stillFrozen && sandboxExec(sandboxId, "test -e /tmp/work/p.txt && echo yes || echo no", { keepPaused: true }) === "yes";
    const r = await call<unknown>("POST", `/agents/${agentId}/resume`, { scope: "agent" });
    const resumedState = await until(async () => (await agentState(agentId)) === "running", 20_000);
    const res = await waitResult(agentId, 600_000);
    const done = sandboxExec(sandboxId, "cat /tmp/work/p.txt 2>/dev/null");
    return [
      { name: "pause accepted", pass: ok2xx(p.status), detail: `HTTP ${p.status} ${short(p.body)}` },
      { name: "daemon reports the agent as paused", pass: statePaused, detail: "state=paused within 20s" },
      { name: "sandbox container really frozen (docker State.Paused)", pass: frozen && stillFrozen, detail: `frozen=${frozen} after45s=${stillFrozen}` },
      { name: "no work progressed while the agent was paused", pass: !progressedWhilePaused, detail: progressedWhilePaused ? "p.txt was written during the pause" : "p.txt absent during the pause" },
      { name: "resume accepted and the agent runs again", pass: ok2xx(r.status) && resumedState, detail: `HTTP ${r.status} runningAgain=${resumedState}` },
      { name: "original work finished after resume (state preserved)", pass: done === "done" && res.outcome === "success", detail: `p.txt=${JSON.stringify(done)} outcome=${res.outcome}` },
    ];
  } finally {
    await deleteRun(run.runId);
  }
}

async function steerWhilePaused(): Promise<Check[]> {
  const { run, agentId, sandboxId } = await startLive(
    `queue-${Date.now()}`,
    "Use your bash tool to run exactly: sleep 30; echo done > /tmp/work/p.txt . After it finishes, reply with exactly OK.",
  );
  try {
    await call("POST", `/agents/${agentId}/pause`, { scope: "agent" });
    await until(async () => (await agentState(agentId)) === "paused", 20_000);
    const t0 = Date.now();
    let steerStatus = 0;
    let body: unknown = null;
    let hung = false;
    try {
      const s = await call<unknown>("POST", `/agents/${agentId}/steer`, { message: "Before you reply, also run exactly: echo C > /tmp/work/c.txt", scope: "agent" }, 20_000);
      steerStatus = s.status;
      body = s.body;
    } catch {
      hung = true; // the request did not return within 20 s
    }
    const steerMs = Date.now() - t0;
    await call("POST", `/agents/${agentId}/resume`, { scope: "agent" });
    const res = await waitResult(agentId, 600_000);
    const c = sandboxExec(sandboxId, "cat /tmp/work/c.txt 2>/dev/null");
    return [
      { name: "steer on a paused agent returns promptly (does not hang)", pass: !hung && ok2xx(steerStatus), detail: hung ? "no reply within 20s" : `HTTP ${steerStatus} in ${steerMs}ms ${short(body)}` },
      { name: "queued instruction applied after resume (c.txt)", pass: c === "C", detail: `c.txt=${JSON.stringify(c)}` },
      { name: "turn finished successfully", pass: res.outcome === "success", detail: String(res.outcome) },
    ];
  } finally {
    await deleteRun(run.runId);
  }
}

async function stopMidTurn(): Promise<Check[]> {
  const { run, agentId, sandboxId } = await startLive(
    `stop-${Date.now()}`,
    "Use your bash tool to run exactly: sleep 120; echo late > /tmp/work/late.txt . Then reply with exactly OK.",
  );
  try {
    const t0 = Date.now();
    const s = await call<unknown>("POST", `/agents/${agentId}/stop`, {});
    let state = await agentState(agentId);
    const terminal = await until(async () => {
      state = await agentState(agentId);
      return TERMINAL.includes(String(state));
    }, 30_000);
    const stopMs = Date.now() - t0;
    await sleep(8_000);
    // If the sandbox was removed by the stop, the work cannot have completed; otherwise look for the file.
    const exists = containerExists(sandboxId);
    const late = exists ? sandboxExec(sandboxId, "test -e /tmp/work/late.txt && echo yes || echo no") : "removed";
    return [
      { name: "stop accepted", pass: ok2xx(s.status), detail: `HTTP ${s.status} ${short(s.body)}` },
      { name: "agent reaches a terminal state within 30 s", pass: terminal, detail: `${state} in ${(stopMs / 1000).toFixed(1)}s` },
      { name: "interrupted work did not complete", pass: late === "no" || late === "removed", detail: `late.txt: ${late}` },
    ];
  } finally {
    await deleteRun(run.runId);
  }
}


/** Does a steer sent to a paused agent block the caller until resume, and what does it answer then? */
async function steerPausedBlocking(): Promise<Check[]> {
  const { run, agentId, sandboxId } = await startLive(
    `block-${Date.now()}`,
    "Use your bash tool to run exactly: sleep 20; echo done > /tmp/work/p.txt . After it finishes, reply with exactly OK.",
  );
  try {
    await call("POST", `/agents/${agentId}/pause`, { scope: "agent" });
    await until(async () => (await agentState(agentId)) === "paused", 20_000);
    const t0 = Date.now();
    let settledAt: number | null = null;
    let status = 0;
    let body: unknown = null;
    const steer = call<unknown>("POST", `/agents/${agentId}/steer`, { message: "Also run exactly: echo D > /tmp/work/d.txt", scope: "agent" }, 120_000)
      .then((r) => {
        settledAt = Date.now() - t0;
        status = r.status;
        body = r.body;
      })
      .catch(() => {
        settledAt = -1;
      });
    await sleep(15_000);
    const blockedWhilePaused = settledAt === null;
    await call("POST", `/agents/${agentId}/resume`, { scope: "agent" });
    const resumeAt = Date.now() - t0;
    await Promise.race([steer, sleep(60_000)]);
    const res = await waitResult(agentId, 600_000);
    const d = sandboxExec(sandboxId, "cat /tmp/work/d.txt 2>/dev/null");
    return [
      { name: "steer on a paused agent returns without waiting for resume", pass: !blockedWhilePaused, detail: blockedWhilePaused ? "still waiting after 15 s paused" : `returned after ${settledAt} ms` },
      { name: "when it returns it reports the instruction as queued/accepted", pass: ok2xx(status), detail: `HTTP ${status} ${short(body)} (resumed at ${resumeAt} ms, steer answered at ${settledAt} ms)` },
      { name: "queued instruction applied (d.txt)", pass: d === "D", detail: `d.txt=${JSON.stringify(d)}` },
      { name: "turn finished successfully", pass: res.outcome === "success", detail: String(res.outcome) },
    ];
  } finally {
    await deleteRun(run.runId);
  }
}

const SCENARIOS: [string, () => Promise<Check[]>][] = [
  ["steer-running-turn", steerRunningTurn],
  ["pause-resume", pauseResume],
  ["steer-while-paused", steerWhilePaused],
  ["stop-mid-turn", stopMidTurn],
  ["steer-paused-blocking", steerPausedBlocking],
];
const only = new Set(arg("only", "").split(",").filter(Boolean));

const repeats = Number(arg("repeats", "1"));
const manifest = collectManifest({ scenario: "steering", repeats, version: 2, model: process.env.BENCH_AGENT_MODEL ?? "openai/gpt-oss-20b" });
const results: ScenarioResult[] = [];
let stoppedEarly: string | undefined;
outer: for (let r = 0; r < repeats; r++) {
  for (const [name, fn] of SCENARIOS.filter(([n]) => only.size === 0 || only.has(n))) {
    const t0 = Date.now();
    try {
      await assertProviderBudget();
      const checks = await fn();
      const res: ScenarioResult = { scenario: name, repeat: r, checks, passed: checks.every((c) => c.pass), ms: Date.now() - t0 };
      results.push(res);
      console.log(`${name}#${r}: ${res.passed ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length} checks, ${(res.ms / 1000).toFixed(0)}s)`);
      for (const c of checks) console.log(`   ${c.pass ? "ok" : "x "} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
    } catch (e) {
      if (e instanceof ProviderCapReached) {
        stoppedEarly = e.message;
        break outer;
      }
      results.push({ scenario: name, repeat: r, checks: [], passed: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      console.log(`${name}#${r}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const passed = results.filter((r) => r.passed).length;
const w = wilson(passed, results.length);
const dir = join(arg("out", "results"), `steering-${manifest.runId}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "result.json"), JSON.stringify({ results, passed, runs: results.length, ci: w, stoppedEarly: stoppedEarly ?? null }, null, 2));
console.log(`\nsteering: ${passed}/${results.length} scenario runs passed (${(100 * w.p).toFixed(0)}%, 95% CI ${(100 * w.lo).toFixed(0)}-${(100 * w.hi).toFixed(0)}%)`);
if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
console.log(`wrote ${dir}`);
