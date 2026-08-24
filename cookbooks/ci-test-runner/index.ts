/**
 * Recipe: run a repo's test suite in a disposable, CI-style sandbox and turn
 * the result into a structured pass/fail report instead of a raw log dump.
 *
 * This scaffolds a tiny Python project on the fly so the recipe runs
 * end-to-end with no external network dependency beyond `pip install pytest`.
 * Swap the "get the repo into the sandbox" step for a real clone:
 *
 *   await sb.exec(`git clone --depth 1 ${repoUrl} /workspace`);
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sb = await client.sandbox({
  image: "python:3.11-slim",
  resources: { cpu: "500m", memory: "512Mi" },
  name: "ci-test-runner",
});

console.log(`SandboxHandle ID: ${sb.sandboxId}\n`);

try {
  // ── 1. Get the repo into the sandbox ──────────────────────────────────────
  await sb.createDirectory("/workspace");
  await sb.writeFile(
    "/workspace/calc.py",
    ["def add(a, b):", "    return a + b", "", "def divide(a, b):", "    return a / b", ""].join(
      "\n",
    ),
  );
  await sb.writeFile(
    "/workspace/test_calc.py",
    [
      "from calc import add, divide",
      "",
      "def test_add():",
      "    assert add(2, 3) == 5",
      "",
      "def test_divide():",
      "    assert divide(10, 2) == 5",
      "",
      "def test_divide_by_zero():",
      "    # deliberately wrong expectation — fails, to show a real failure report",
      "    assert divide(1, 0) == 0",
      "",
    ].join("\n"),
  );

  // ── 2. Install and run ────────────────────────────────────────────────────
  console.log("Installing test dependencies...");
  await sb.exec("pip install --quiet pytest");

  console.log("Running test suite...\n");
  const { stdout, stderr, exitCode } = await sb.exec("cd /workspace && pytest -q", {
    strict: false,
    timeoutMs: 60_000,
  });

  // ── 3. Turn the raw log into a structured report ──────────────────────────
  const summaryLine = stdout.trim().split("\n").pop() ?? "";
  const passed = exitCode === 0;

  console.log("=== CI Report ===");
  console.log(`status:  ${passed ? "PASS" : "FAIL"}`);
  console.log(`summary: ${summaryLine}`);
  if (!passed) {
    console.log("\n--- pytest output ---");
    console.log(stdout || stderr);
  }

  if (!passed) process.exitCode = 1;
} finally {
  await sb.close();
}
