/**
 * Swarm outcome: a root agent fans out to N child agents through alineod's spawn API, each child does a small
 * computation, and the harness gathers and checks every result by code. Measures what is specific to Alineo:
 * spawn latency, await/gather semantics, per-child correctness, and failures under fan-out.
 *
 * Usage: bun src/swarm.ts [--levels 2,4,8] [--out results]
 * Env:   BENCH_AGENT_PROVIDER / BENCH_AGENT_MODEL as for the other runners.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpec, call, deleteRun, getRun, startRun, waitResult } from "./alineod.ts";
import { collectManifest } from "./manifest.ts";
import { summarize } from "./stats.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface ChildResult {
  agentId: string;
  expected: string;
  got: string | null;
  outcome: string | null;
  correct: boolean;
}

interface LevelResult {
  children: number;
  spawnMs: number;
  allSettledMs: number;
  correct: number;
  failed: number;
  spawnLatency: ReturnType<typeof summarize>;
  results: ChildResult[];
  awaitOutcome: string;
}

/** Child i adds the integers from i to i+9 (a unique, code-checkable answer per child). */
const task = (i: number) => ({
  prompt: `Compute the sum of the integers from ${i} to ${i + 9} inclusive. Reply with only the number, nothing else.`,
  expected: String(Array.from({ length: 10 }, (_, k) => i + k).reduce((a, b) => a + b, 0)),
});

async function runLevel(n: number): Promise<LevelResult> {
  const root = await startRun(
    agentSpec({ name: `swarm-root-${n}`, extra: { spawnDepth: 1, maxAgents: n + 2 } }),
    "Reply with exactly: READY",
  );
  try {
    await waitResult(root.rootAgentId, 600_000);
    const t0 = performance.now();
    const spawned: { id: string; expected: string; spawnMs: number }[] = [];
    // Spawn all children as fast as the API allows; the daemon admits and provisions them.
    await Promise.all(
      Array.from({ length: n }, async (_, k) => {
        const t = task(k * 7 + 1);
        const s0 = performance.now();
        const r = await call<{ agentId: string; state: string }>(
          "POST",
          `/runs/${root.runId}/agents`,
          {
            spec: agentSpec({ name: `swarm-child-${n}-${k}` }),
            parentAgentId: root.rootAgentId,
            prompt: t.prompt,
          },
        );
        if (r.status >= 300) throw new Error(`spawn failed ${r.status}: ${JSON.stringify(r.body)}`);
        spawned.push({ id: r.body.agentId, expected: t.expected, spawnMs: performance.now() - s0 });
      }),
    );
    const spawnMs = performance.now() - t0;

    // Gather: hold on the daemon's await until every child is terminal (or give up after 10 minutes).
    let awaitOutcome = "pending";
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline && awaitOutcome === "pending") {
      const w = await call<{ outcome: string }>(
        "POST",
        `/runs/${root.runId}/await`,
        { agents: spawned.map((s) => s.id), mode: "settled", wait: 30 },
        60_000,
      );
      awaitOutcome = w.body?.outcome ?? "pending";
    }
    const allSettledMs = performance.now() - t0;

    const results: ChildResult[] = [];
    for (const s of spawned) {
      const r = await call<{ outcome: string | null; result: string | null }>(
        "GET",
        `/agents/${s.id}/result`,
      );
      const got = (r.body?.result ?? "").trim();
      results.push({
        agentId: s.id,
        expected: s.expected,
        got: r.body?.result ?? null,
        outcome: r.body?.outcome ?? null,
        // The child may add a short sentence; the right number must be present as a whole token.
        correct:
          r.body?.outcome === "success" && new RegExp(`(^|\\D)${s.expected}(\\D|$)`).test(got),
      });
    }
    const tree = await getRun(root.runId);
    void tree;
    return {
      children: n,
      spawnMs,
      allSettledMs,
      correct: results.filter((r) => r.correct).length,
      failed: results.filter((r) => r.outcome !== "success").length,
      spawnLatency: summarize(spawned.map((s) => s.spawnMs)),
      results,
      awaitOutcome,
    };
  } finally {
    await deleteRun(root.runId);
  }
}

const levels = arg("levels", "2,4,8").split(",").map(Number);
const manifest = collectManifest({ scenario: "swarm-outcome", levels });
const out: LevelResult[] = [];
for (const n of levels) {
  console.log(`fan-out to ${n} children ...`);
  try {
    const r = await runLevel(n);
    out.push(r);
    console.log(
      `  correct ${r.correct}/${n}, failed turns ${r.failed}, spawn ${(r.spawnMs / 1000).toFixed(1)}s, all settled ${(r.allSettledMs / 1000).toFixed(1)}s, await=${r.awaitOutcome}`,
    );
  } catch (e) {
    console.log(`  level ${n} errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const dir = join(arg("out", "results"), `swarm-${manifest.runId}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "result.json"), JSON.stringify(out, null, 2));
console.log(`wrote ${dir}`);
