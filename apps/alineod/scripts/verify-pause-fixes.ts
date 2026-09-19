/**
 * Live check of the pause fixes (research/subtree-controls-fixes.md — G3, B1/B2, B4, B7) against
 * a real OpenSandbox, through alineod's HTTP API. Starts its own alineod on a separate port (so
 * it can kill -9 and restart it) with its own state dir and a short stream inactivity timeout:
 *
 *   T1 (B1+B2)  pause a turn mid tool call for 3x the inactivity timeout → resume → full result
 *   T2 (B4)     spawn under a paused parent → child holds with no sandbox → resume → child answers
 *   T3 (B7)     pause mid-turn → kill -9 alineod → restart → still paused → resume → full result
 *   T4 (#1)     3-level swarm (root → c1 → g1), pause the root's SUBTREE mid-turn for ~200s with a
 *               kill -9 + restart in the middle → resume the subtree → every turn's full result
 *               (run explicitly: `... verify-pause-fixes.ts t4`)
 *   T5 (#2)     batch stop: 3-level swarm + a finished sibling → stop the subtree → every member
 *               applied, the finished one keeps success, every sandbox gone
 *   T6 (#3/#4)  waitFor any / quorum / deadline against real workers; operator await + quiescence
 *   T7 (#5)     notifyOn: a subscriber mid tool call is steered when its dependency finishes
 *   T8 (#6)     subtree steer: a running parent gets one message with its children's roster
 *               (run explicitly: `... verify-pause-fixes.ts t5,t6,t7,t8`)
 *
 * Usage (on the OpenSandbox host, from the repo root, with NVIDIA_API_KEY in the environment):
 *   set -a; . ./.env; set +a
 *   bun apps/alineod/scripts/verify-pause-fixes.ts [t1,t2,t3]
 *
 * Writes everything it observes to ./verify-pause-fixes/results.json (daemon logs alongside).
 *
 * The pause is timed off the agent reaching `running`, not off a `tool_start` event: once the
 * stream goes quiet for the inactivity timeout (the model thinking is enough), alineod follows the
 * turn by polling and no further harness events reach SSE (G2), so waiting for one can hang.
 *
 * T2 judges the hold (child waits in `spawning` with no sandbox, then the fork is attempted after
 * resume) separately from whether the forked child's harness starts: on a host where forks don't
 * carry the parent's filesystem, the child's bridge can't start — outside what B4 changes.
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

/**
 * Unique per run: the SDK reuses a cached snapshot per spec name + setup hash, and on a host where
 * snapshots don't carry the container's filesystem (gVisor) a restored sandbox has no harness.
 */
const RUN_TAG = Date.now().toString(36);

function spec(name: string, extra: Json = {}): Json {
  return {
    name: `${name}-${RUN_TAG}`,
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
  return {
    state: v.state,
    outcome: v.outcome,
    sandboxId: v.sandboxId,
    endedAt: v.endedAt,
    pausedBy: v.pausedBy,
  };
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

async function waitState(agentId: string, state: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await agentView(agentId);
    if (v.state === state) return;
    if (v.outcome)
      throw new Error(`${agentId} ended before reaching ${state}: ${JSON.stringify(v)}`);
    await sleep(1_000);
  }
  throw new Error(`${agentId} never reached ${state}`);
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
      prompt: sleepPrompt("T1_SLEPT_OK", 90),
    });
    const runId = r.runId as string;
    const id = r.rootAgentId as string;
    runs.push(runId);
    Object.assign(obs, { runId, agentId: id });
    log("T1: run", runId);

    await waitState(id, "running");
    await sleep(10_000); // mid-turn: the model thinking, or already inside the sleep tool call

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
    const lc = obs.lifecycle as Json[];
    const resumeIdx = lc.findIndex((e) => e.event === "agent_state_changed" && e.from === "paused");
    const endedIdx = lc.findIndex((e) => e.event === "agent_ended");
    obs.endedAfterResume = resumeIdx !== -1 && endedIdx > resumeIdx;
    obs.pass =
      during.state === "paused" &&
      during.outcome === null &&
      obs.endedAfterResume === true &&
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
    const lc = lifecycle(await ledger(runId), childId) as Json[];
    obs.childLifecycle = lc;
    const held = obs.childWhileParentPaused as Json;
    const ended = lc.find((e) => e.event === "agent_ended");
    // B4's job: hold while the parent is paused, then fork after resume — never fail for "paused".
    obs.holdPass =
      held.state === "spawning" &&
      held.sandboxId === null &&
      held.outcome === null &&
      lc[0]?.reason === "parent-paused" &&
      !/INVALID_SOURCE_STATE|Running sandbox/i.test(String(ended?.error ?? ""));
    obs.childAnswered = result.outcome === "success" && String(result.result).includes("CHILD_OK");
    obs.pass = obs.holdPass === true && obs.childAnswered === true;
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
      prompt: sleepPrompt("T3_SLEPT_OK", 90),
    });
    const runId = r.runId as string;
    const id = r.rootAgentId as string;
    runs.push(runId);
    Object.assign(obs, { runId, agentId: id });
    log("T3: run", runId);

    await waitState(id, "running");
    await sleep(10_000);
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

// ── T4: subtree pause across a restart ────────────────────────────────────────

async function t4(): Promise<void> {
  const obs: Json = {};
  results.t4 = obs;
  const views = async (ids: Record<string, string>) =>
    Object.fromEntries(
      await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await agentView(id)])),
    );
  try {
    const r = await api("POST", "/runs", { spec: spec("verify-subtree-root", { spawnDepth: 3 }) });
    const runId = r.runId as string;
    const root = r.rootAgentId as string;
    runs.push(runId);
    await waitLive(root);

    const c1 = (
      await api("POST", `/runs/${runId}/agents`, {
        parentAgentId: root,
        spec: spec("verify-subtree-c1"),
        prompt: sleepPrompt("C1_SLEPT_OK", 120),
      })
    ).agentId as string;
    await waitLive(c1);
    const g1 = (
      await api("POST", `/runs/${runId}/agents`, {
        parentAgentId: c1,
        spec: spec("verify-subtree-g1"),
        prompt: sleepPrompt("G1_SLEPT_OK", 120),
      })
    ).agentId as string;
    await waitLive(g1);
    await api("POST", `/agents/${root}/prompt`, { text: sleepPrompt("ROOT_SLEPT_OK", 120) });
    const ids = { root, c1, g1 };
    Object.assign(obs, { runId, ids });
    for (const id of Object.values(ids)) await waitState(id, "running");
    log("T4: 3-level swarm running");
    await sleep(10_000); // mid-turn for all three (model thinking, or inside the sleep)

    const paused = await api("POST", `/agents/${root}/pause`, { scope: "subtree" });
    obs.pauseResults = paused.results;
    obs.afterPause = await views(ids);
    log("T4: subtree paused", JSON.stringify(paused.results));

    await sleep(60_000);
    daemon?.kill(9);
    await daemon?.exited;
    await sleep(5_000);
    await startDaemon("t4-restart");
    obs.afterRestart = await views(ids);
    log("T4: daemon restarted while the subtree was paused");

    await sleep(135_000); // ~200s paused in total — 10x the 20s inactivity timeout
    obs.beforeResume = await views(ids);

    const resumed = await api("POST", `/agents/${root}/resume`, { scope: "subtree" });
    obs.resumeResults = resumed.results;
    log("T4: subtree resumed", JSON.stringify(resumed.results));

    const res: Record<string, Json> = {};
    for (const [k, id] of Object.entries(ids)) {
      const out = await waitResult(id);
      res[k] = { outcome: out.outcome, text: out.result };
    }
    obs.results = res;
    obs.lifecycle = Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([k, id]) => [k, lifecycle(await ledger(runId), id)]),
      ),
    );

    const allApplied = (xs: unknown) =>
      Array.isArray(xs) && xs.length === 3 && xs.every((x) => (x as Json).outcome === "applied");
    const stillPaused = (v: Json) =>
      Object.values(v).every((a) => (a as Json).state === "paused" && (a as Json).outcome === null);
    const markers: Record<string, string> = {
      root: "ROOT_SLEPT_OK",
      c1: "C1_SLEPT_OK",
      g1: "G1_SLEPT_OK",
    };
    obs.pass =
      allApplied(obs.pauseResults) &&
      stillPaused(obs.afterPause as Json) &&
      stillPaused(obs.afterRestart as Json) &&
      stillPaused(obs.beforeResume as Json) &&
      allApplied(obs.resumeResults) &&
      Object.entries(markers).every(
        ([k, m]) => res[k]?.outcome === "success" && String(res[k]?.text).includes(m),
      );
    log("T4:", obs.pass ? "PASS" : "FAIL", JSON.stringify(res));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T4: ERROR", errMsg(e));
  }
  save();
}

// ── T5–T8: batch stop, coordination, notifyOn, subtree steer ─────────────────────

async function newRun(name: string): Promise<{ runId: string; root: string }> {
  const r = await api("POST", "/runs", { spec: spec(name, { spawnDepth: 3 }) });
  const runId = r.runId as string;
  runs.push(runId);
  await waitLive(r.rootAgentId as string);
  return { runId, root: r.rootAgentId as string };
}

async function spawnUnder(
  runId: string,
  parentId: string,
  name: string,
  prompt?: string,
  extra: Json = {},
): Promise<string> {
  const r = await api("POST", `/runs/${runId}/agents`, {
    parentAgentId: parentId,
    spec: spec(name),
    ...(prompt ? { prompt } : {}),
    ...extra,
  });
  return r.agentId as string;
}

function containerExists(sandboxId: string | null | undefined): boolean {
  if (!sandboxId) return false;
  const r = Bun.spawnSync(["docker", "ps", "-a", "-q", "--filter", `name=sandbox-${sandboxId}`]);
  return r.stdout.toString().trim().length > 0;
}

async function t5(): Promise<void> {
  const obs: Json = {};
  results.t5 = obs;
  try {
    const { runId, root } = await newRun("verify-t5-root");
    const c1 = await spawnUnder(runId, root, "verify-t5-c1", sleepPrompt("C1_SLEPT_OK", 120));
    await waitLive(c1);
    const g1 = await spawnUnder(runId, c1, "verify-t5-g1", sleepPrompt("G1_SLEPT_OK", 120));
    const quick = await spawnUnder(runId, root, "verify-t5-quick", "Reply with only: QUICK_OK");
    await waitLive(g1);
    await waitResult(quick);
    await waitState(c1, "running");
    await waitState(g1, "running");
    const ids = { root, c1, g1, quick };
    const before = Object.fromEntries(
      await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await agentView(id)])),
    );
    log("T5: stopping the subtree");
    const res = await api("POST", `/agents/${root}/stop`, { scope: "subtree" });
    obs.results = res.results;
    await sleep(5_000);
    const after = Object.fromEntries(
      await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await agentView(id)])),
    );
    obs.after = after;
    obs.containersLeft = Object.entries(before)
      .filter(([, v]) => containerExists((v as Json).sandboxId as string))
      .map(([k]) => k);
    const rs = res.results as Json[];
    obs.pass =
      rs.length === 4 &&
      rs.every((r) => r.outcome === "applied") &&
      (after.quick as Json).outcome === "success" &&
      ["root", "c1", "g1"].every((k) => (after[k] as Json).outcome === "aborted") &&
      (obs.containersLeft as string[]).length === 0;
    log("T5:", obs.pass ? "PASS" : "FAIL", JSON.stringify(rs));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T5: ERROR", errMsg(e));
  }
  save();
}

async function t6(): Promise<void> {
  const obs: Json = {};
  results.t6 = obs;
  try {
    const { runId, root } = await newRun("verify-t6-root");
    const fast = await spawnUnder(runId, root, "verify-t6-fast", "Reply with only: FAST_OK");
    const medium = await spawnUnder(runId, root, "verify-t6-medium", sleepPrompt("MEDIUM_OK", 45));
    const slow = await spawnUnder(runId, root, "verify-t6-slow", sleepPrompt("SLOW_OK", 120));
    const deps = [fast, medium, slow];
    const readInputs =
      "Use your bash tool to run exactly: cat /inputs.json\nThen reply with only its output, on one line.";
    const anyC = await spawnUnder(runId, root, "verify-t6-any", readInputs, {
      waitFor: { agents: deps, mode: "any" },
    });
    const quorumC = await spawnUnder(runId, root, "verify-t6-quorum", readInputs, {
      waitFor: { agents: deps, mode: "quorum", k: 2 },
    });
    const deadlineC = await spawnUnder(runId, root, "verify-t6-deadline", readInputs, {
      waitFor: { agents: [slow], deadlineSec: 30 },
    });
    Object.assign(obs, { runId, fast, medium, slow, anyC, quorumC, deadlineC });

    const out: Record<string, Json> = {};
    for (const [k, id] of Object.entries({ anyC, quorumC, deadlineC })) {
      const r = await waitResult(id);
      out[k] = { outcome: r.outcome, text: r.result };
    }
    obs.children = out;
    const ev = await ledger(runId);
    const resolved = (id: string) =>
      ev.find((e) => e.event === "wait_resolved" && e.data.agentId === id)?.data;
    obs.waits = { any: resolved(anyC), quorum: resolved(quorumC), deadline: resolved(deadlineC) };
    log("T6: waits", JSON.stringify(obs.waits));

    const all = await api("POST", `/runs/${runId}/await`, { agents: deps, mode: "all", wait: 220 });
    obs.awaitAll = { outcome: all.outcome, pending: all.pending };
    const q = await api("GET", `/agents/${slow}/await?scope=subtree&wait=60`);
    obs.slowQuiescent = q.quiescent;

    const w = obs.waits as Record<string, Json | undefined>;
    obs.pass =
      JSON.stringify(w.any?.selected) === JSON.stringify([fast]) &&
      Array.isArray(w.quorum?.selected) &&
      (w.quorum.selected as string[]).length === 2 &&
      !(w.quorum.selected as string[]).includes(slow) &&
      w.deadline?.outcome === "partial" &&
      all.outcome === "satisfied" &&
      q.quiescent === true;
    log("T6:", obs.pass ? "PASS" : "FAIL", JSON.stringify(out));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T6: ERROR", errMsg(e));
  }
  save();
}

async function t7(): Promise<void> {
  const obs: Json = {};
  results.t7 = obs;
  try {
    const { runId, root } = await newRun("verify-t7-root");
    const dep = await spawnUnder(runId, root, "verify-t7-dep");
    await waitLive(dep);
    const sub = await spawnUnder(
      runId,
      root,
      "verify-t7-sub",
      "Use your bash tool to run exactly this command: sleep 90 && echo SUB_SLEPT\n" +
        "When it finishes, reply with SUB_SLEPT and then, on separate lines, the agent id of every " +
        "update you received from other agents while you worked (write NONE if you received none).",
      { notifyOn: [dep] },
    );
    await waitState(sub, "running");
    await sleep(15_000);
    await api("POST", `/agents/${dep}/prompt`, { text: "Reply with only: DEP_READY" });
    await waitResult(dep);
    const r = await waitResult(sub);
    const inbox = await api("GET", `/agents/${sub}/inbox`);
    obs.subResult = { outcome: r.outcome, text: r.result };
    obs.inbox = inbox.delivered;
    const delivered = (inbox.delivered as Json[])[0];
    obs.pass =
      delivered?.deliveredAs === "steer" &&
      r.outcome === "success" &&
      String(r.result).includes(dep);
    log(
      "T7:",
      obs.pass ? "PASS" : "FAIL",
      JSON.stringify(obs.subResult),
      JSON.stringify(delivered),
    );
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T7: ERROR", errMsg(e));
  }
  save();
}

async function t8(): Promise<void> {
  const obs: Json = {};
  results.t8 = obs;
  try {
    const { runId, root } = await newRun("verify-t8-lead");
    const c1 = await spawnUnder(runId, root, "verify-t8-auth", sleepPrompt("AUTH_OK", 150));
    const c2 = await spawnUnder(runId, root, "verify-t8-perf", sleepPrompt("PERF_OK", 150));
    await waitLive(c1);
    await waitLive(c2);
    await api("POST", `/agents/${root}/prompt`, {
      text:
        "Use your bash tool to run exactly this command: sleep 60 && echo LEAD_SLEPT\n" +
        "When it finishes, follow any operator instructions you received; if you received none, reply with LEAD_SLEPT.",
    });
    await waitState(root, "running");
    await sleep(15_000);
    const steer = await api("POST", `/agents/${root}/steer`, {
      scope: "subtree",
      message:
        "New instruction: do not run any more commands. Reply with one line per sub-agent you have, " +
        "in the form CHILD <agentId> <sandboxId>, and nothing else.",
    });
    obs.steer = { deliveredAs: steer.deliveredAs, roster: steer.roster };
    const r = await waitResult(root);
    obs.leadResult = { outcome: r.outcome, text: r.result };
    const text = String(r.result);
    obs.pass = steer.deliveredAs === "steer" && text.includes(c1) && text.includes(c2);
    log("T8:", obs.pass ? "PASS" : "FAIL", JSON.stringify(obs.leadResult));
  } catch (e) {
    obs.error = errMsg(e);
    obs.pass = false;
    log("T8: ERROR", errMsg(e));
  }
  save();
}

// ── main ──────────────────────────────────────────────────────────────────────

try {
  results.runTag = RUN_TAG;
  await startDaemon("initial");
  const parallel: Promise<void>[] = [];
  if (only.has("t1")) parallel.push(t1());
  if (only.has("t2")) parallel.push(t2());
  await Promise.all(parallel);
  if (only.has("t3")) await t3();
  if (only.has("t4")) await t4();
  if (only.has("t5")) await t5();
  if (only.has("t6")) await t6();
  if (only.has("t7")) await t7();
  if (only.has("t8")) await t8();
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
