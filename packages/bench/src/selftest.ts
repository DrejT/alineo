/**
 * Task self-test: for every task, in a clean container, (1) the untouched task must FAIL its verifier,
 * (2) the reference solution must PASS it. Catches broken expected values and over-strict checks before any
 * agent run. Needs Docker.
 *
 * Usage: bun src/selftest.ts [--image python:3.11-slim]
 */
import { execFileSync } from "node:child_process";
import { normalizeOutput } from "./normalize.ts";
import { PASSES_UNTOUCHED, REFERENCES } from "./references.ts";
import { buildRepo, CLEAN_FILE, FIXTURES } from "./review-suite.ts";
import { ALL_TASKS } from "./task-registry.ts";
import { seedCommand } from "./tasks.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const image = arg("image", "python:3.11-slim");
const name = `bench-selftest-${Date.now()}`;
const sh = (args: string[], timeout = 60_000) =>
  execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
const inBox = (script: string) => {
  try {
    return normalizeOutput(sh(["exec", name, "bash", "-c", script]));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `ERROR: ${(err.stderr ?? "").toString().trim().slice(0, 200)}`;
  }
};

sh(["run", "-d", "--name", name, image, "sleep", "900"], 180_000);
let failures = 0;
try {
  for (const t of ALL_TASKS) {
    inBox("rm -rf /tmp/work && mkdir -p /tmp/work");
    inBox(seedCommand(t));
    const want = normalizeOutput(t.expect);
    const before = inBox(t.verify);
    const ref = REFERENCES[t.id];
    if (!ref) {
      console.log(`FAIL ${t.id}: no reference solution`);
      failures++;
      continue;
    }
    inBox(ref);
    const after = inBox(t.verify);
    const untouchedOk = PASSES_UNTOUCHED.has(t.id) || before !== want;
    const solvedOk = after === want;
    if (!untouchedOk || !solvedOk) failures++;
    console.log(
      `${untouchedOk && solvedOk ? "ok  " : "FAIL"} ${t.id}` +
        (untouchedOk ? "" : "  <- verifier passes on the UNTOUCHED task") +
        (solvedOk
          ? ""
          : `  <- reference gave ${JSON.stringify(after.slice(0, 80))}, expected ${JSON.stringify(want.slice(0, 80))}`),
    );
  }
  // Code-review fixtures: every seeded bug must be real (test fails on the buggy code, passes on the fixed code).
  const { files, bugs } = buildRepo();
  for (const f of FIXTURES) {
    const buggy = files[f.file]!;
    const run = (src: string) => {
      inBox("rm -rf /tmp/fx && mkdir -p /tmp/fx");
      for (const [n, body] of [
        [f.file, src],
        ["t.py", f.test],
      ] as const) {
        inBox(`echo ${Buffer.from(body).toString("base64")} | base64 -d > /tmp/fx/${n}`);
      }
      return inBox("cd /tmp/fx && python3 t.py && echo PASS || echo FAIL");
    };
    const onBuggy = run(buggy).endsWith("FAIL");
    const onFixed = run(f.fixed).endsWith("PASS");
    const nBugs = bugs.filter((b) => b.file === f.file).length;
    const ok = onBuggy && onFixed && nBugs === 2;
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} review fixture ${f.file}: test fails on buggy=${onBuggy}, passes on fixed=${onFixed}, seeded bugs=${nBugs}`,
    );
  }
  const clean = inBox(
    `echo ${Buffer.from(CLEAN_FILE.source).toString("base64")} | base64 -d > /tmp/fx/c.py && python3 -c "import sys; sys.path.insert(0,'/tmp/fx'); import c; assert c.gcd(12,18)==6 and c.clamp(5,1,3)==3; print('CLEAN-OK')"`,
  );
  if (!clean.endsWith("CLEAN-OK")) failures++;
  console.log(
    `${clean.endsWith("CLEAN-OK") ? "ok  " : "FAIL"} review clean file behaves correctly`,
  );
} finally {
  try {
    sh(["rm", "-f", name]);
  } catch {
    // best effort
  }
}
console.log(
  failures
    ? `\n${failures} task(s) failed the self-test`
    : `\nall ${ALL_TASKS.length} tasks pass the self-test`,
);
process.exit(failures ? 1 : 0);
