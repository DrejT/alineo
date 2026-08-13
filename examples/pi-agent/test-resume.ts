/**
 * Feature 7 — Agent.resume() end-to-end test
 *
 * Tests that a new process can reconnect to a running agent sandbox,
 * restart the bridge with --continue, and continue the Pi session
 * (context is preserved across the reconnect).
 *
 * Run: bun examples/pi-agent/test-resume.ts
 * Needs: OpenSandbox server running (uvx opensandbox-server)
 */
import { Agent } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const SPEC = "./agents/hello-agent.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");

// ── Step 1: Spawn a fresh agent and seed its session ─────────────────────────
console.log("=== Step 1: Load agent and seed session ===\n");
const agent = await Agent.load(SPEC, { adapter });
const sandboxId = agent.sandboxId;
console.log(`Sandbox ID: ${sandboxId}\n`);

process.stdout.write("Initial prompt → ");
for await (const chunk of agent.prompt("Remember the secret number 99. Reply with just OK.")) {
  process.stdout.write(chunk);
}
console.log("\n");

// ── Step 2: Simulate host process crash ──────────────────────────────────────
console.log("=== Step 2: Simulate bridge crash (pkill) ===\n");
await agent.sandbox.exec("pkill -f 'node /alineo-bridge.js' 2>/dev/null; true", { strict: false });

// Give the process a moment to die.
await new Promise<void>((r) => setTimeout(r, 800));
console.log("Bridge killed. Container still running.\n");

// Do NOT call agent.close() — simulating the host process exiting abruptly.

// ── Step 3: Reconnect via Agent.resume() ─────────────────────────────────────
console.log("=== Step 3: Resume agent in a new process ===\n");
const resumed = await Agent.resume(sandboxId, { adapter, specPath: SPEC });
console.log(`Resumed sandbox ID: ${resumed.sandboxId}\n`);

if (resumed.sandboxId !== sandboxId) {
  throw new Error(`ERROR: sandbox IDs don't match (${resumed.sandboxId} vs ${sandboxId})`);
}

process.stdout.write("Resumed prompt → ");
let fullResponse = "";
for await (const chunk of resumed.prompt(
  "What secret number did I ask you to remember? Answer in one sentence.",
)) {
  process.stdout.write(chunk);
  fullResponse += chunk;
}
console.log("\n");

// ── Step 4: Validate session continuity ──────────────────────────────────────
console.log("=== Step 4: Validate context was preserved ===\n");
const remembered = fullResponse.includes("99");
if (remembered) {
  console.log('✓ Pi remembered "99" — session continuity confirmed.');
} else {
  console.log(
    '✗ Pi did not mention "99" — session may not have continued (check --continue flag).',
  );
  console.log(`  Full response: ${fullResponse.trim()}`);
}

await resumed.close();
console.log("\nResumed agent closed. Test complete.");
