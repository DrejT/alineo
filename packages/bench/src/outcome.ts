/**
 * Task-outcome benchmark: run each task N times through alineod, then verify the result inside the
 * agent's own sandbox with a shell command (independent of the agent's claims).
 *
 * RUN-ON-IMPORT: this file starts agents as soon as it is loaded. Never import it from tests or other
 * modules (import types with `import type`, helpers from their own modules).
 *
 * Usage: bun src/outcome.ts [--suite easy|hard|hard2|all] [--split dev|test|all] [--tasks id,id]
 *                          [--repeats 2] [--concurrency 1] [--max-attempts 3] [--out results]
 * Env:   BENCH_AGENT_PROVIDER (default groq), BENCH_AGENT_MODEL (default openai/gpt-oss-20b),
 *        GROQ_API_KEY (optional here: lets the run stop cleanly when the provider's daily token cap is hit)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpec, deleteRun, getRun, startRun, waitResult } from "./alineod.ts";
import { assertProviderBudget, ProviderCapReached } from "./budget.ts";
import { collectManifest } from "./manifest.ts";
import { wilson } from "./metrics.ts";
import { normalizeOutput } from "./normalize.ts";
import { selectTasks, type Suite } from "./task-registry.ts";
import { seedCommand, splitOf, type Task } from "./tasks.ts";
import { fetchRunEvidence, type Usage } from "./trace.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

export interface OutcomeRow {
  task: string;
  repeat: number;
  split?: "dev" | "test";
  agentOutcome: string | null;
  passed: boolean;
  /** The verifier's output matched even if the agent's turn ended as failed (kept to tell the two apart). */
  outputCorrect?: boolean;
  /** For tasks with a message check: did the agent's final message match it? */
  messageOk?: boolean;
  /** How many times the run was started (1 = no retry) and how many ended as infrastructure failures. */
  attempts?: number;
  infraFailures?: number;
  verifyOutput: string;
  wallMs: number;
  finalText: string;
  /** Compact record of what the agent actually ran, from alineod's event stream (judge evidence). */
  trace: string;
  /** Tokens the agent used, from the harness's per-message usage. */
  usage?: Usage;
}

function verifyInSandbox(sandboxId: string, t: Task): string {
  const name = `sandbox-${sandboxId}`;
  // alineod pauses a sandbox once its agent settles; docker exec refuses a paused container.
  try {
    execFileSync("docker", ["unpause", name], { stdio: "ignore", timeout: 15_000 });
  } catch {
    // already running
  }
  try {
    return normalizeOutput(
      execFileSync("docker", ["exec", name, "bash", "-c", t.verify], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return `VERIFY-ERROR: ${(err.stderr ?? err.message).toString().trim().slice(0, 300)}`;
  }
}

async function runAttempt(t: Task, repeat: number): Promise<OutcomeRow> {
  const t0 = performance.now();
  const spec = agentSpec({
    name: `bench-${t.id}-${repeat}`,
    extra: { packages: ["python3"], setup: [{ name: "seed", run: seedCommand(t) }] },
  });
  const run = await startRun(spec, t.prompt);
  try {
    const res = await waitResult(run.rootAgentId, 900_000);
    const tree = await getRun(run.runId);
    const sandboxId = tree.agents[0]?.sandboxId;
    const out = sandboxId ? verifyInSandbox(sandboxId, t) : "VERIFY-ERROR: no sandbox";
    const finalText = res.result ?? "";
    const outputCorrect = out === normalizeOutput(t.expect);
    const messageOk = t.messageCheck ? t.messageCheck.test(finalText) : undefined;
    const evidence = await fetchRunEvidence(run.runId, run.rootAgentId);
    return {
      task: t.id,
      repeat,
      split: splitOf(t.id),
      agentOutcome: res.outcome,
      passed: res.outcome === "success" && outputCorrect && messageOk !== false,
      outputCorrect,
      ...(messageOk === undefined ? {} : { messageOk }),
      verifyOutput: out,
      wallMs: performance.now() - t0,
      finalText,
      trace: evidence.trace,
      usage: evidence.usage,
    };
  } finally {
    await deleteRun(run.runId);
  }
}

/**
 * An agent turn that ends `failed` is an infrastructure failure (model quota/429, snapshot timeout, a rejected
 * tool call), not the agent getting the task wrong: a wrong answer still ends `success` and fails the verifier.
 * Retry those so a blip does not get recorded as a task failure, and report the retries separately.
 */
const MAX_ATTEMPTS = Number(arg("max-attempts", "3"));
async function runOne(t: Task, repeat: number): Promise<OutcomeRow> {
  let infraFailures = 0;
  for (let attempt = 1; ; attempt++) {
    await assertProviderBudget();
    const row = await runAttempt(t, repeat);
    if (row.agentOutcome !== "failed" || attempt >= MAX_ATTEMPTS) {
      return {
        ...row,
        attempts: attempt,
        infraFailures: infraFailures + (row.agentOutcome === "failed" ? 1 : 0),
      };
    }
    infraFailures++;
    console.log(
      `${t.id}#${repeat}: agent turn failed (attempt ${attempt}), retrying after a pause`,
    );
    await new Promise((r) => setTimeout(r, 45_000 * attempt));
  }
}

const repeats = Number(arg("repeats", "2"));
const concurrency = Number(arg("concurrency", "1"));
const suite = arg("suite", "easy") as Suite;
const split = arg("split", "all") as "dev" | "test" | "all";
const only = new Set(arg("tasks", "").split(",").filter(Boolean));
const chosen = selectTasks(suite, split).filter((t) => only.size === 0 || only.has(t.id));
const manifest = collectManifest({
  scenario: "task-outcome",
  suite,
  split,
  repeats,
  concurrency,
  tasks: chosen.map((t) => t.id),
  provider: process.env.BENCH_AGENT_PROVIDER ?? "groq",
  model: process.env.BENCH_AGENT_MODEL ?? "openai/gpt-oss-20b",
});

// Interleave repeats across tasks (a#0, b#0, ..., a#1, b#1, ...) so a run cut short by a daily cap still has
// every task represented at least once.
const queue = Array.from({ length: repeats }, (_, r) => chosen.map((t) => ({ t, r }))).flat();
const rows: OutcomeRow[] = [];
let stoppedEarly: string | undefined;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item && !stoppedEarly; item = queue.shift()) {
      let row: OutcomeRow;
      try {
        row = await runOne(item.t, item.r);
      } catch (e) {
        if (e instanceof ProviderCapReached) {
          stoppedEarly = e.message;
          console.log(`STOP: ${e.message}; ${queue.length + 1} runs not started`);
          break;
        }
        row = {
          task: item.t.id,
          repeat: item.r,
          split: splitOf(item.t.id),
          agentOutcome: "error",
          passed: false,
          verifyOutput: "",
          wallMs: 0,
          finalText: e instanceof Error ? e.message : String(e),
          trace: "",
        };
      }
      rows.push(row);
      console.log(
        `${row.task}#${row.repeat}: ${row.passed ? "PASS" : "FAIL"} (${(row.wallMs / 1000).toFixed(0)}s)`,
      );
    }
  }),
);

const dir = join(
  arg("out", "results"),
  `outcome-${suite}${split === "all" ? "" : "-" + split}-${manifest.runId}`,
);
mkdirSync(dir, { recursive: true });
const pct = (k: number, n: number) => {
  const w = wilson(k, n);
  return `${k}/${n} = ${(100 * w.p).toFixed(0)}% (95% CI ${(100 * w.lo).toFixed(0)}-${(100 * w.hi).toFixed(0)}%)`;
};
const passed = rows.filter((r) => r.passed).length;
const firstAttempt = rows.filter((r) => r.passed && (r.attempts ?? 1) === 1).length;
const stats = {
  runs: rows.length,
  passed,
  passRate: wilson(passed, rows.length),
  firstAttemptPassRate: wilson(firstAttempt, rows.length),
  infraFailures: rows.reduce((a, r) => a + (r.infraFailures ?? 0), 0),
  attempts: rows.reduce((a, r) => a + (r.attempts ?? 1), 0),
  tokens: rows.reduce((a, r) => a + (r.usage?.total ?? 0), 0),
  bySplit: Object.fromEntries(
    (["dev", "test"] as const).map((s) => {
      const rs = rows.filter((r) => r.split === s);
      return [
        s,
        {
          runs: rs.length,
          passed: rs.filter((r) => r.passed).length,
          ...wilson(rs.filter((r) => r.passed).length, rs.length),
        },
      ];
    }),
  ),
  byTask: Object.fromEntries(
    chosen.map((t) => {
      const rs = rows.filter((r) => r.task === t.id);
      return [
        t.id,
        { runs: rs.length, passed: rs.filter((r) => r.passed).length, split: splitOf(t.id) },
      ];
    }),
  ),
  stoppedEarly: stoppedEarly ?? null,
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "rows.json"), JSON.stringify(rows, null, 2));
writeFileSync(join(dir, "stats.json"), JSON.stringify(stats, null, 2));
console.log(`\npass rate: ${pct(passed, rows.length)}`);
console.log(
  `first-attempt pass rate: ${pct(firstAttempt, rows.length)}; infra failures ${stats.infraFailures} over ${stats.attempts} attempts; tokens ${stats.tokens}`,
);
for (const s of ["dev", "test"] as const) {
  const b = stats.bySplit[s]!;
  if (b.runs) console.log(`  ${s}: ${pct(b.passed, b.runs)}`);
}
if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
console.log(`wrote ${dir}`);
for (const r of rows.filter((x) => !x.passed)) {
  console.log(
    `FAIL ${r.task}#${r.repeat} outcome=${r.agentOutcome} verify=${JSON.stringify(r.verifyOutput.slice(0, 120))}${r.messageOk === false ? " (message check failed)" : ""}`,
  );
}
