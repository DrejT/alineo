/**
 * Live check of the pause fixes (research/subtree-controls-fixes.md — G3, B1/B2, B4, B7) against
 * a real OpenSandbox, through alineod's HTTP API. Starts its own alineod on a separate port (so
 * it can kill -9 and restart it) with its own state dir and a short stream inactivity timeout:
 *
 *   T1 (B1+B2)  pause a turn mid tool call for 3x the inactivity timeout → resume → full result
 *   T2 (B4)     spawn under a paused parent → child holds with no sandbox → resume → child answers
 *   T3 (B7)     pause mid-turn → kill -9 alineod → restart → still paused → resume → full result
 *
 * Usage (on the OpenSandbox host, from the repo root, with NVIDIA_API_KEY in the environment):
 *   set -a; . ./.env; set +a
 *   bun apps/alineod/scripts/verify-pause-fixes.ts [t1,t2,t3]
 *
 * Writes everything it observes to ./verify-pause-fixes/results.json (daemon logs alongside).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const only = new Set((process.argv[2] ?? "t1,t2,t3").split(","));
const PORT = Number(process.env.VERIFY_PORT ?? 4610);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = resolve(process.env.VERIFY_DIR ?? "verify-pause-fixes");
const INACTIVITY_MS = 20_000;
const MODEL = process.env.VERIFY_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b";
const REPO_ROOT = resolve(import.meta.dir, "../../..");

mkdirSync(DIR, { recursive: true });
const OUT = join(DIR, "results.json");
const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  port: PORT,
  inactivityMs: INACTIVITY_MS,
  model: MODEL,
};
const save = () => {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
};

const t0 = Date.now();
const log = (...a: unknown[]) => {
  console.log(`[verify +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── daemon ────────────────────────────────────────────────────────────────────

let daemon: ReturnType<typeof Bun.spawn> | undefined;

async function startDaemon(label: string): Promise<void> {
  daemon = Bun.spawn(["bun", join(REPO_ROOT, "apps/alineod/server.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ALINEOD_PORT: String(PORT),
      ALINEOD_DB_PATH: join(DIR, "alineod.db"),
      ALINEOD_SDK_LEDGER_PATH: join(DIR, "sdk-ledger.db"),
      ALINEOD_WORK_DIR: join(DIR, "work"),
      ALINEOD_PROMPT_INACTIVITY_MS: String(INACTIVITY_MS),
    },
    stdout: Bun.file(join(DIR, `daemon-${label}.log`)),
    stderr: Bun.file(join(DIR, `daemon-${label}.err.log`)),
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        log(`daemon (${label}) up, pid ${daemon.pid}`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`daemon (${label}) did not come up`);
}

// ── API helpers ───────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : {}) as Json;
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return { ...parsed, _status: res.status };
}

function spec(name: string, extra: Json = {}): Json {
  return {
    name,
    cli: "pi",
    provider: "nvidia",
    model: MODEL,
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
    ...extra,
  };
}

const sleepPrompt = (marker: string, secs: number) =>
  `Use your bash tool to run exactly this command: sleep ${secs} && echo ${marker}\n` +
  `When it finishes, reply with only DONE followed by the command's output.`;

async function agentView(agentId: string): Promise<Json> {
  const v = await api("GET", `/agents/${agentId}`);
  return { state: v.state, outcome: v.outcome, sandboxId: v.sandboxId, endedAt: v.endedAt };
}

async function waitLive(agentId: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await agentView(agentId);
    if (v.sandboxId) return;
    if (v.outcome) throw new Error(`${agentId} ended before provisioning: ${JSON.stringify(v)}`);
    await sleep(2_000);
  }
  throw new Error(`${agentId} never provisioned`);
}

async function waitResult(agentId: string, timeoutMs = 600_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/agents/${agentId}/result?wait=60`);
    if (res.status === 200) return (await res.json()) as Json;
  }
  throw new Error(`no result for ${agentId} within ${timeoutMs}ms`);
}

/** Read the run's SSE stream (replay + live) until `pred` matches or the timeout passes. */
async function waitEvent(
  runId: string,
  pred: (event: string, data: Json) => boolean,
  timeoutMs: number,
): Promise<{ event: string; data: Json } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${BASE}/runs/${runId}/events`, { signal: ctrl.signal });
    if (!res.body) return null;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: ?(.*)$/m.exec(frame)?.[1];
        const raw = /^data: ?(.*)$/m.exec(frame)?.[1];
        if (!event || !raw) continue;
        let data: Json;
        try {
          data = JSON.parse(raw) as Json;
        } catch {
          continue;
        }
        if (pred(event, data)) return { event, data };
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Every persisted event for the run so far (replayed from the ledger), with a short idle cut-off. */
async function ledger(runId: string): Promise<{ event: string; data: Json }[]> {
  const out: { event: string; data: Json }[] = [];
  await waitEvent(
    runId,
    (event, data) => {
      out.push({ event, data });
      return false;
    },
    3_000,
  );
  return out;
}

function lifecycle(events: { event: string; data: Json }[], agentId: string) {
  return events
    .filter(
      (e) =>
        e.data.agentId === agentId &&
        ["agent_state_changed", "agent_provisioned", "handle_settled", "agent_ended"].includes(
          e.event,
        ),
    )
    .map((e) => {
      const { agentId: _a, ...rest } = e.data;
      return { event: e.event, ...rest };
    });
}

const runs: string[] = [];

// ── T1: pause longer than the inactivity timeout mid tool call ───────────────

async function t1(): Promise<void> {
  const obs: Json = {};
  results.t1 = obs;
  try {
    const r = await api("POST", "/runs", {
      spec: spec("verify-pause-t1"),
      prompt: sleepPrompt("T1_SLEPT_OK", 60),
    });
    const runId = r.runId as string;
    const id = r.rootAgentId as string;
    runs.push(runId);
    Object.assign(obs, { runId, agentId: id });
    log("T1: run", runId);

    const tool = await waitEvent(runId, (e, d) => e === "tool_start" && d.agentId === id, 600_000);
    obs.toolStartSeen = Boolean(tool);
    await sleep(3_000);

    await api("POST", `/agents/${id}/pause`);
    obs.pausedAt = Date.now() - t0;
    log("T1: paused");
    await sleep(INACTIVITY_MS * 3);
    obs.duringPause = await agentView(id);
    obs.resultStatusDuringPause = (await fetch(`${BASE}/agents/${id}/result`)).status;

    obs.resume = (await api("POST", `/agents/${id}/resume`))._status;
    obs.resumedAt = Date.now() - t0;
    log("T1: resumed; waiting for result");

    const result = await waitResult(id);
    obs.result = { outcome: result.outcome, text: result.result };
    obs.lifecycle = lifecycle(await ledger(runId), id);
    const during = obs.duringPause as Json;
    obs.pass =
      during.state === "paused" &&
      during.outcome === null &&
      result.outcome === "success" &&
      String(result.result).includes("T1_SLEPT_OK");
    log("T1:", obs.pass ? "PASS" : "FAIL", JSON.stringify(obs.result));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T1: ERROR", errMsg(e));
  }
  save();
}

// ── T2: spawn under a paused parent ──────────────────────────────────────────

async function t2(): Promise<void> {
  const obs: Json = {};
  results.t2 = obs;
  try {
    const r = await api("POST", "/runs", { spec: spec("verify-pause-t2", { spawnDepth: 2 }) });
    const runId = r.runId as string;
    const id = r.rootAgentId as string;
    runs.push(runId);
    Object.assign(obs, { runId, parentId: id });
    await waitLive(id);
    log("T2: parent live");

    await api("POST", `/agents/${id}/pause`);
    const c = await api("POST", `/runs/${runId}/agents`, {
      parentAgentId: id,
      spec: spec("verify-pause-t2-child"),
      prompt: "Reply with only: CHILD_OK",
    });
    const childId = c.agentId as string;
    obs.childId = childId;
    obs.spawnAccepted = c._status;
    log("T2: child", childId, "requested under paused parent");

    await sleep(20_000);
    obs.childWhileParentPaused = await agentView(childId);

    await api("POST", `/agents/${id}/resume`);
    log("T2: parent resumed");
    const result = await waitResult(childId);
    obs.childResult = { outcome: result.outcome, text: result.result };
    obs.childLifecycle = lifecycle(await ledger(runId), childId);
    const held = obs.childWhileParentPaused as Json;
    obs.pass =
      held.state === "spawning" &&
      held.sandboxId === null &&
      held.outcome === null &&
      result.outcome === "success" &&
      String(result.result).includes("CHILD_OK");
    log("T2:", obs.pass ? "PASS" : "FAIL", JSON.stringify(obs.childResult));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T2: ERROR", errMsg(e));
  }
  save();
}

// ── T3: kill -9 alineod while an agent is paused mid-turn ────────────────────

async function t3(): Promise<void> {
  const obs: Json = {};
  results.t3 = obs;
  try {
    const r = await api("POST", "/runs", {
      spec: spec("verify-pause-t3"),
      prompt: sleepPrompt("T3_SLEPT_OK", 60),
    });
    const runId = r.runId as string;
    const id = r.rootAgentId as string;
    runs.push(runId);
    Object.assign(obs, { runId, agentId: id });
    log("T3: run", runId);

    obs.toolStartSeen = Boolean(
      await waitEvent(runId, (e, d) => e === "tool_start" && d.agentId === id, 600_000),
    );
    await sleep(3_000);
    await api("POST", `/agents/${id}/pause`);
    log("T3: paused; killing alineod with SIGKILL");

    daemon?.kill(9);
    await daemon?.exited;
    obs.killed = true;
    await sleep(5_000);
    await startDaemon("t3-restart");

    obs.afterRestart = await agentView(id);
    await sleep(INACTIVITY_MS * 2);
    obs.afterWaiting = await agentView(id);
    const restartLog = readFileSync(join(DIR, "daemon-t3-restart.log"), "utf8");
    obs.rehydrateLog = restartLog
      .split("\n")
      .filter((l) => l.includes(id) || l.includes("rehydrat"));

    obs.resume = (await api("POST", `/agents/${id}/resume`))._status;
    log("T3: resumed; waiting for result");
    const result = await waitResult(id);
    obs.result = { outcome: result.outcome, text: result.result };
    obs.lifecycle = lifecycle(await ledger(runId), id);

    const after = obs.afterRestart as Json;
    const waited = obs.afterWaiting as Json;
    obs.pass =
      after.state === "paused" &&
      waited.state === "paused" &&
      waited.outcome === null &&
      result.outcome === "success" &&
      String(result.result).includes("T3_SLEPT_OK");
    log("T3:", obs.pass ? "PASS" : "FAIL", JSON.stringify(obs.result));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T3: ERROR", errMsg(e));
  }
  save();
}

// ── main ──────────────────────────────────────────────────────────────────────

try {
  await startDaemon("initial");
  const parallel: Promise<void>[] = [];
  if (only.has("t1")) parallel.push(t1());
  if (only.has("t2")) parallel.push(t2());
  await Promise.all(parallel);
  if (only.has("t3")) await t3();
} catch (e) {
  results.fatal = errMsg(e);
  log("FATAL", errMsg(e));
} finally {
  for (const runId of runs) {
    try {
      await api("DELETE", `/runs/${runId}`);
    } catch (e) {
      log("cleanup failed for", runId, errMsg(e));
    }
  }
  daemon?.kill();
  results.finishedAt = new Date().toISOString();
  save();
  log("done →", OUT);
  process.exit(0);
}
