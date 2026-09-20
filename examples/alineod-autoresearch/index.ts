/**
 * An autoresearch-style loop, run in parallel across sandboxed agents.
 *
 * Karpathy's autoresearch gives one agent a single file to edit, a single metric to lower, and a
 * fixed time budget per experiment. This example keeps that shape and swaps the GPU training run
 * for a task that needs only a CPU: each researcher edits `task/model.py`, a character-level
 * language model, to lower `val_bpc` (bits per character on held-out text) as measured by
 * `task/evaluate.py`, which it may not edit.
 *
 *   lead (root, idle)         holds the task files in /work
 *   ├─ researcher-1 … -N      fork the lead's sandbox, each with its own starting direction
 *
 *   1. build the lab and fork N researchers   POST /runs, POST /runs/:runId/agents
 *   2. supervise each researcher              GET  /agents/:id, GET /agents/:id/result
 *      until its turn ends with a valid result, nudging it (POST /agents/:id/prompt) if not
 *   3. stop the rest once K are valid         POST /agents/:id/stop
 *
 * No SDK needed — plain HTTP. Needs a running alineod (see README) with NVIDIA_API_KEY in *its*
 * environment.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";
const RESEARCHERS = Number(process.env.RESEARCHERS ?? 4);
const QUORUM = Number(process.env.QUORUM ?? 2);
const DEADLINE_MS = Number(process.env.DEADLINE_MIN ?? 20) * 60_000;
const MODEL = process.env.MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const KEEP_RUN = process.env.KEEP_RUN === "1"; // leave the sandboxes up so you can inspect /work

const DIRECTIONS = [
  "smoothing: replace add-one smoothing with something better (add-k, absolute discounting, Kneser-Ney).",
  "context length: use longer contexts, backing off to shorter ones when a context is unseen.",
  "mixing: interpolate the predictions of several context lengths instead of picking one.",
  "your own idea: anything you think will lower val_bpc.",
];

function agentSpec(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    cli: "pi",
    provider: "nvidia",
    model: MODEL,
    // Resolved from alineod's own environment — the key never travels in the request.
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "500m", memory: "1Gi" },
    ...extra,
  };
}

/** Setup steps that write the task files into /work. A shell argument is capped at ~128 KB, so big files go in chunks. */
function taskSetup(): { name: string; run: string }[] {
  const steps = [{ name: "workdir", run: "mkdir -p /work" }];
  for (const file of ["program.md", "model.py", "evaluate.py", "data.txt"]) {
    const b64 = readFileSync(new URL(`./task/${file}`, import.meta.url)).toString("base64");
    for (let i = 0, n = 1; i < b64.length; i += 40_000, n++) {
      const op = i === 0 ? ">" : ">>";
      steps.push({
        name: `${file} ${n}`,
        run: `printf %s '${b64.slice(i, i + 40_000)}' | base64 -d ${op} /work/${file}`,
      });
    }
  }
  return steps;
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

async function waitFor(
  agentId: string,
  ready: (a: { sandboxId?: string; state: string }) => boolean,
) {
  for (;;) {
    const agent = await api("GET", `/agents/${agentId}`);
    if (ready(agent)) return;
    if (agent.outcome && agent.outcome !== "success")
      throw new Error(`${agent.specName} ended early: ${agent.outcome}`);
    await Bun.sleep(2_000);
  }
}

const t0 = Date.now();
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const log = (msg: string) => console.log(`${stamp()}  ${msg}`);
const names = new Map<string, string>();

log(`building the lab (${RESEARCHERS} researchers, first ${QUORUM} to finish decide)`);
const run = await api("POST", "/runs", {
  spec: agentSpec("lead", { setup: taskSetup() }),
  budget: { spawnDepth: 1, maxAgents: RESEARCHERS },
  prompt: "Reply with exactly: READY",
});
const { runId, rootAgentId: lead } = run;
try {
  await waitFor(lead, (a) => a.state === "done");
  log("lead is ready; /work holds program.md, model.py, evaluate.py, data.txt");

  const ids: string[] = [];
  for (let i = 0; i < RESEARCHERS; i++) {
    const direction = DIRECTIONS[i % DIRECTIONS.length]!;
    const { agentId } = await api("POST", `/runs/${runId}/agents`, {
      spec: agentSpec(`researcher-${i + 1}`),
      parentAgentId: lead,
      prompt: `Read /work/program.md and follow it exactly. Your starting direction — ${direction}`,
    });
    names.set(agentId, `researcher-${i + 1}`);
    ids.push(agentId);
    log(`researcher-${i + 1} forked (${agentId}): ${direction.split(":")[0]}`);
  }

  // A researcher's turn ending is not the same as it having a result: the agent can stop without
  // printing the RESULT line, and a model API that answers "overloaded" ends the turn too (alineod
  // now records that as `failed`; older versions recorded `success`). So each researcher gets a
  // supervisor: wait for the turn to end, check the result, and if it isn't a real one, tell the
  // agent to carry on. Stop everyone else once QUORUM are valid.
  const MAX_NUDGES = Number(process.env.MAX_NUDGES ?? 4);
  const NUDGE =
    "Your last turn ended early because of an error, not because you finished. Your work is in /work " +
    "(model.py, model.py.best). Carry on with the loop in program.md, and finish with the RESULT line.";
  const RESULT_LINE = /RESULT\s+baseline=([\d.]+)\s+best=([\d.]+)\s+idea=(.*)/;
  const good: { id: string; baseline: string; best: string; idea: string }[] = [];
  let stopping = false;
  let reached!: () => void;
  const enough = new Promise<void>((r) => (reached = r));

  const inState = async (id: string, states: string[], timeoutMs: number) => {
    for (
      const end = Date.now() + timeoutMs;
      Date.now() < end && !stopping;
      await Bun.sleep(3_000)
    ) {
      if (states.includes((await api("GET", `/agents/${id}`)).state)) return;
    }
  };

  const supervise = async (id: string) => {
    const name = names.get(id)!;
    for (let nudge = 0; !stopping; nudge++) {
      await inState(id, ["done", "failed", "aborted", "lost"], DEADLINE_MS);
      if (stopping) return;
      const { result } = await api("GET", `/agents/${id}/result`);
      const m = RESULT_LINE.exec(result ?? "");
      if (m) {
        good.push({ id, baseline: m[1]!, best: m[2]!, idea: m[3]!.trim() });
        log(`${name} reported val_bpc ${m[2]} (baseline ${m[1]})`);
        if (good.length >= QUORUM) reached();
        return;
      }
      if (nudge >= MAX_NUDGES) return void log(`${name} gave up after ${MAX_NUDGES} nudges`);
      log(`${name}'s turn ended without a RESULT line — nudging it (${nudge + 1}/${MAX_NUDGES})`);
      // A model API that's overloaded fails again straight away, so back off before each nudge.
      await Bun.sleep(15_000 * (nudge + 1));
      if (stopping) return;
      await api("POST", `/agents/${id}/prompt`, { text: NUDGE });
      await inState(id, ["running"], 30_000);
    }
  };

  const all = Promise.all(ids.map(supervise));
  const deadline = new Promise<void>((r) =>
    setTimeout(r, Math.max(0, DEADLINE_MS - (Date.now() - t0))),
  );
  await Promise.race([enough, all, deadline]);
  stopping = true;

  log(`${good.length} of ${QUORUM} valid results; stopping the rest`);
  const decided = new Set(good.map((g) => g.id));
  for (const id of ids.filter((i) => !decided.has(i))) {
    const agent = await api("GET", `/agents/${id}`);
    if (["running", "spawning", "provisioning", "done"].includes(agent.state)) {
      await api("POST", `/agents/${id}/stop`).catch(() => {});
      log(`stopped ${names.get(id)}`);
    }
  }

  console.log("\nresearcher     baseline   best   idea   (as reported by the agent)");
  good.sort((a, b) => Number(a.best) - Number(b.best));
  for (const g of good)
    console.log(
      `${names.get(g.id)!.padEnd(14)} ${g.baseline.padEnd(10)} ${g.best.padEnd(6)} ${g.idea}`,
    );
  if (good[0])
    console.log(`\nbest: ${names.get(good[0].id)} at val_bpc ${good[0].best} (lower is better)`);
  if (KEEP_RUN)
    console.log(`run ${runId} left running (KEEP_RUN=1); delete it with DELETE /runs/${runId}`);
} finally {
  if (!KEEP_RUN) await api("DELETE", `/runs/${runId}`).catch(() => {});
}
