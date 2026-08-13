/**
 * Workspace setup test — verifies that setup steps run on first load,
 * are baked into the snapshot, and survive a second load without re-running.
 *
 * Run:  bun examples/pi-agent/test-workspace.ts
 * Needs: OpenSandbox running (uvx opensandbox-server) and NVIDIA_API_KEY in .env
 *
 * Expected output:
 *   Load 1: fromSnapshot=false, setup steps logged, workspace files present
 *   Load 2: fromSnapshot=true,  no setup steps logged, workspace files still present
 */
import { Agent, textOnly } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const SPEC = "./agents/workspace-agent.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");

// ── Load 1: full install + setup steps + checkpoint ───────────────────────────
console.log("=== Load 1 — full install ===\n");
const agent1 = await Agent.load(SPEC, { adapter });
console.log(`\nSandbox: ${agent1.sandboxId}  fromSnapshot=${agent1.fromSnapshot}\n`);

if (agent1.fromSnapshot) {
  console.log("WARN: got snapshot on load 1 — delete agent-snapshots.json to force rebuild");
}

// Verify workspace files are present after setup steps.
const indexJs = (await agent1.sandbox.exec("cat /workspace/index.js")).stdout.trim();
const nodeOut = (await agent1.sandbox.exec("node /workspace/index.js")).stdout.trim();
console.log(`/workspace/index.js content: ${indexJs}`);
console.log(`node output: ${nodeOut}`);

if (!nodeOut.includes("workspace ready")) {
  throw new Error(`Unexpected node output: ${nodeOut}`);
}

// Ask Pi to list the workspace — it should see the files setup baked in.
console.log("\nAsking Pi to inspect /workspace...\n");
let response1 = "";
for await (const chunk of textOnly(
  agent1.prompt("List the files in /workspace using bash and tell me what you find."),
)) {
  process.stdout.write(chunk);
  response1 += chunk;
}
console.log("\n");

await agent1.close();
console.log("Agent 1 closed.\n");

// ── Load 2: restore from snapshot — setup steps must NOT re-run ───────────────
console.log("=== Load 2 — from snapshot ===\n");
const agent2 = await Agent.load(SPEC, { adapter });
console.log(`\nSandbox: ${agent2.sandboxId}  fromSnapshot=${agent2.fromSnapshot}\n`);

if (!agent2.fromSnapshot) {
  console.log("WARN: expected snapshot on load 2 — snapshot may not have been saved");
}

// Workspace files must still be there after restore.
const nodeOut2 = (await agent2.sandbox.exec("node /workspace/index.js")).stdout.trim();
console.log(`node output after restore: ${nodeOut2}`);

if (!nodeOut2.includes("workspace ready")) {
  throw new Error(`Workspace lost after snapshot restore — setup steps may not have been included`);
}

await agent2.close();
console.log("Agent 2 closed.\n");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("─".repeat(60));
console.log("=== Summary ===\n");
console.log(`Load 1 fromSnapshot: ${agent1.fromSnapshot}  (expected: false)`);
console.log(`Load 2 fromSnapshot: ${agent2.fromSnapshot}  (expected: true)`);
console.log(`Workspace survived snapshot: ${nodeOut2.includes("workspace ready")}`);

const pass = !agent1.fromSnapshot && agent2.fromSnapshot && nodeOut2.includes("workspace ready");
console.log(
  pass ? "\n✓ Workspace setup working correctly" : "\n✗ Test failed — check output above",
);
