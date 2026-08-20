/**
 * Alineo snapshotting test — verifies that a second Alineo.load() for the same
 * spec uses the cached snapshot instead of reinstalling Pi.
 *
 * Run: bun examples/pi-agent/test-snapshot.ts
 * Needs: OpenSandbox server running (uvx opensandbox-server)
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const SPEC = "./agents/hello-agent.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");

// ── First load: full install + checkpoint ─────────────────────────────────────
console.log("=== Load 1: full install ===\n");
const t1 = Date.now();
const agent1 = await Alineo.load(SPEC, { adapter });
const elapsed1 = Date.now() - t1;
console.log(`\nLoad 1 total: ${elapsed1}ms  fromSnapshot=${agent1.fromSnapshot}`);

if (agent1.fromSnapshot) {
  console.log(
    "(snapshot already existed from a previous run — delete .alineo/agent-snapshots.json to reset)",
  );
}

// Quick sanity check.
process.stdout.write("Prompt → ");
for await (const chunk of agent1.prompt("Reply with just the word READY.")) {
  process.stdout.write(chunk);
}
console.log("\n");

await agent1.close();
console.log("Alineo 1 closed.\n");

// ── Second load: should restore from snapshot ─────────────────────────────────
console.log("=== Load 2: snapshot restore ===\n");
const t2 = Date.now();
const agent2 = await Alineo.load(SPEC, { adapter });
const elapsed2 = Date.now() - t2;
console.log(`\nLoad 2 total: ${elapsed2}ms  fromSnapshot=${agent2.fromSnapshot}`);

process.stdout.write("Prompt → ");
for await (const chunk of agent2.prompt("Reply with just the word READY.")) {
  process.stdout.write(chunk);
}
console.log("\n");

await agent2.close();
console.log("Alineo 2 closed.\n");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("=== Summary ===\n");
console.log(`Load 1 (install): ${elapsed1}ms  fromSnapshot=${agent1.fromSnapshot}`);
console.log(`Load 2 (resume):  ${elapsed2}ms  fromSnapshot=${agent2.fromSnapshot}`);

if (agent2.fromSnapshot && elapsed2 < elapsed1 / 3) {
  console.log(`\n✓ Snapshot fast path working: ${Math.round(elapsed1 / elapsed2)}x speedup`);
} else if (agent2.fromSnapshot) {
  console.log(`\n✓ Load 2 used snapshot (fromSnapshot=true)`);
} else {
  console.log(`\n✗ Load 2 did not use a snapshot — check .alineo/agent-snapshots.json`);
}
