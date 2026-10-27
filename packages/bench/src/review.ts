/**
 * Code-review benchmark: an agent reviews a small repo with seeded bugs; the review is scored by code
 * (recall of the 12 seeded bugs, precision of the findings, false alarms on a clean file).
 *
 * `--per-file` reviews one module per run (7 runs per round: six buggy modules and the clean one). The whole-repo
 * mode puts all seven files in one prompt, and on Groq's free tier (8,000 tokens per minute) that single request
 * is large enough that the next one is rejected, so every whole-repo run failed. Per-file runs fit.
 *
 * Usage: bun src/review.ts [--repeats 3] [--per-file] [--out results]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpec, deleteRun, getRun, startRun, waitResult } from "./alineod.ts";
import { assertProviderBudget, ProviderCapReached } from "./budget.ts";
import { collectManifest } from "./manifest.ts";
import { mean, wilson } from "./metrics.ts";
import { buildRepo, parseFindings, REVIEW_PROMPT, scoreReview, type Finding, type SeededBug } from "./review-suite.ts";
import { fetchRunEvidence, type Usage } from "./trace.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const { files: allFiles, bugs: allBugs } = buildRepo();
const perFile = process.argv.includes("--per-file");

interface Unit {
  label: string;
  files: Record<string, string>;
  bugs: SeededBug[];
}
const units: Unit[] = perFile
  ? Object.entries(allFiles).map(([n, body]) => ({ label: n, files: { [n]: body }, bugs: allBugs.filter((b) => b.file === n) }))
  : [{ label: "whole-repo", files: allFiles, bugs: allBugs }];

const seedFor = (files: Record<string, string>) =>
  "mkdir -p /tmp/work/repo && " +
  Object.entries(files)
    .map(([n, body]) => `echo ${Buffer.from(body).toString("base64")} | base64 -d > /tmp/work/repo/${n}`)
    .join(" && ");

function inSandbox(sandboxId: string, script: string): string {
  const name = `sandbox-${sandboxId}`;
  try {
    execFileSync("docker", ["unpause", name], { stdio: "ignore", timeout: 15_000 });
  } catch {
    // already running
  }
  try {
    return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", timeout: 60_000 });
  } catch {
    return "";
  }
}

interface Row {
  unit: string;
  repeat: number;
  agentOutcome: string | null;
  findings: Finding[];
  bugs: number;
  found: number;
  truePositives: number;
  cleanFileFalseAlarms: number;
  modifiedCode: boolean;
  attempts: number;
  wallMs: number;
  usage?: Usage;
  rawReview: string;
}

async function attempt(unit: Unit, repeat: number): Promise<Row> {
  const t0 = performance.now();
  const run = await startRun(
    agentSpec({ name: `bench-review-${unit.label.replace(/\W/g, "")}-${repeat}`, extra: { packages: ["python3"], setup: [{ name: "seed", run: seedFor(unit.files) }] } }),
    REVIEW_PROMPT,
  );
  try {
    const res = await waitResult(run.rootAgentId, 900_000);
    const sandboxId = (await getRun(run.runId)).agents[0]?.sandboxId ?? null;
    const raw = sandboxId ? inSandbox(sandboxId, "cat /tmp/work/review.json 2>/dev/null") : "";
    const sums = sandboxId ? inSandbox(sandboxId, "cd /tmp/work/repo && sha256sum *.py") : "";
    const modified = Object.entries(unit.files).some(([n, b]) => !sums.includes(`${createHash("sha256").update(b).digest("hex")}  ${n}`));
    const findings = parseFindings(raw);
    const s = scoreReview(findings, unit.bugs);
    const evidence = await fetchRunEvidence(run.runId, run.rootAgentId);
    return {
      unit: unit.label,
      repeat,
      agentOutcome: res.outcome,
      findings: res.outcome === "success" ? findings : [],
      bugs: unit.bugs.length,
      found: res.outcome === "success" ? s.found : 0,
      truePositives: res.outcome === "success" ? s.truePositives : 0,
      cleanFileFalseAlarms: res.outcome === "success" ? s.falsePositivesOnCleanFile : 0,
      modifiedCode: modified,
      attempts: 1,
      wallMs: performance.now() - t0,
      usage: evidence.usage,
      rawReview: raw.slice(0, 1200),
    };
  } finally {
    await deleteRun(run.runId);
  }
}

const repeats = Number(arg("repeats", "3"));
const maxAttempts = 3;
const rows: Row[] = [];
let stoppedEarly: string | undefined;
outer: for (let r = 0; r < repeats; r++) {
  for (const unit of units) {
    let row: Row | undefined;
    for (let a = 1; a <= maxAttempts && !row; a++) {
      try {
        await assertProviderBudget();
        const x = await attempt(unit, r);
        if (x.agentOutcome === "failed" && a < maxAttempts) {
          console.log(`review ${unit.label}#${r}: agent turn failed (attempt ${a}), retrying`);
          await new Promise((res) => setTimeout(res, 45_000 * a));
          continue;
        }
        row = { ...x, attempts: a };
      } catch (e) {
        if (e instanceof ProviderCapReached) {
          stoppedEarly = e.message;
          break outer;
        }
        row = { unit: unit.label, repeat: r, agentOutcome: "error", findings: [], bugs: unit.bugs.length, found: 0, truePositives: 0, cleanFileFalseAlarms: 0, modifiedCode: false, attempts: a, wallMs: 0, rawReview: String(e) };
      }
    }
    if (row) {
      rows.push(row);
      console.log(
        `review ${row.unit}#${r}: ${row.agentOutcome === "success" ? `found ${row.found}/${row.bugs} bugs, ${row.truePositives}/${row.findings.length} findings real${row.cleanFileFalseAlarms ? `, ${row.cleanFileFalseAlarms} false alarm(s) on the clean file` : ""}` : `no score (${row.agentOutcome})`}${row.modifiedCode ? " [MODIFIED THE CODE]" : ""}`,
      );
    }
  }
}

const scored = rows.filter((r) => r.agentOutcome === "success");
const totalBugs = scored.reduce((a, r) => a + r.bugs, 0);
const totalFound = scored.reduce((a, r) => a + r.found, 0);
const totalFind = scored.reduce((a, r) => a + r.findings.length, 0);
const totalTp = scored.reduce((a, r) => a + r.truePositives, 0);
const summary = {
  mode: perFile ? "per-file" : "whole-repo",
  runs: rows.length,
  scored: scored.length,
  recall: wilson(totalFound, totalBugs),
  precision: wilson(totalTp, totalFind),
  seededBugsSeen: totalBugs,
  findings: totalFind,
  falseAlarmsOnCleanFile: scored.reduce((a, r) => a + r.cleanFileFalseAlarms, 0),
  modifiedCodeRuns: rows.filter((r) => r.modifiedCode).length,
  meanFindingsPerRun: mean(scored.map((r) => r.findings.length)),
  stoppedEarly: stoppedEarly ?? null,
};
const manifest = collectManifest({ scenario: "code-review", mode: summary.mode, repeats, bugs: allBugs.length, model: process.env.BENCH_AGENT_MODEL ?? "openai/gpt-oss-20b" });
const dir = join(arg("out", "results"), `review-${manifest.runId}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "rows.json"), JSON.stringify({ summary, rows, seededBugs: allBugs }, null, 2));
const pc = (w: { p: number; lo: number; hi: number }) => `${(100 * w.p).toFixed(0)}% (95% CI ${(100 * w.lo).toFixed(0)}-${(100 * w.hi).toFixed(0)}%)`;
console.log(`\nmode ${summary.mode}: recall ${totalFound}/${totalBugs} = ${pc(summary.recall)}; precision ${totalTp}/${totalFind} = ${pc(summary.precision)}; clean-file false alarms ${summary.falseAlarmsOnCleanFile}; ${summary.scored}/${summary.runs} runs scored`);
if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
console.log(`wrote ${dir}`);
