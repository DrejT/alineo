/**
 * Recipe: an AI agent that debugs a failing test and fixes the bug itself —
 * inside its own sandbox, using nothing but bash and a model.
 *
 * Needs a running OpenSandbox server (`alineo init`) and NVIDIA_API_KEY in the
 * environment — the agent config below uses the NVIDIA NIM API (free tier
 * available). Swap "provider"/"model" in agents/bugfix-agent.json for any
 * provider in @alineo-labs/model-providers to use a different key instead.
 */
import { Agent, textOnly } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const agent = await Agent.load("./agents/bugfix-agent.json", { adapter });

console.log(`Sandbox: ${agent.sandboxId}\n`);

try {
  // ── 1. Plant a bug ─────────────────────────────────────────────────────────
  await agent.sandbox.exec("mkdir -p /workspace");
  await agent.sandbox.writeFile(
    "/workspace/calc.py",
    ["def average(nums):", "    return sum(nums) / len(nums) - 1  # bug: off by one", ""].join(
      "\n",
    ),
  );
  await agent.sandbox.writeFile(
    "/workspace/test_calc.py",
    [
      "from calc import average",
      "",
      "def test_average():",
      "    assert average([1, 2, 3]) == 2",
      "",
    ].join("\n"),
  );
  await agent.sandbox.exec("cd /workspace && pip install --quiet pytest");

  console.log("=== Before: failing test ===\n");
  for await (const chunk of textOnly(agent.bash("cd /workspace && pytest -q || true"))) {
    process.stdout.write(chunk);
  }

  // ── 2. Ask the agent to find and fix the bug ────────────────────────────────
  console.log("\n=== Agent fixing the bug ===\n");
  for await (const chunk of textOnly(
    agent.prompt(
      "There's a failing test in /workspace. Run pytest to see the failure, find the bug in " +
        "calc.py, fix it, and re-run pytest to confirm it passes. Keep your reply short.",
    ),
  )) {
    process.stdout.write(chunk);
  }

  // ── 3. Verify independently ──────────────────────────────────────────────────
  console.log("\n\n=== After: verifying independently ===\n");
  const { stdout, exitCode } = await agent.sandbox.exec("cd /workspace && pytest -q", {
    strict: false,
  });
  console.log(stdout.trim());
  console.log(exitCode === 0 ? "\nAgent fixed the bug." : "\nStill failing.");
} finally {
  await agent.close();
  console.log("\nAgent closed.");
}
