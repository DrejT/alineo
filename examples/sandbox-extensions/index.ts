/**
 * Integration test for sandbox API extensions:
 *   Feature 1 — diagnosticLogs() / diagnosticEvents()
 *   Feature 2 — watchMetrics()
 *   Feature 3 — pause() / resume()
 *   Feature 4 — createSession() / BashSession
 *   Feature 7 — Alineo.resume()
 *
 * Run: bun examples/sandbox-extensions/index.ts
 * Needs: OpenSandbox server running (uvx opensandbox-server)
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { Alineo } from "alineo";

const adapter = new SQLiteAdapter("./.alineo/test-extensions.db");
const client = new Sandbox({
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  adapter,
});

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

// ── Feature 1 + 2 + 3 + 4 ────────────────────────────────────────────────────
section("Spawning sandbox");
const sb = await client.sandbox({
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "ext-test",
});
console.log(`SandboxHandle: ${sb.sandboxId}`);

try {
  // ── Feature 1 — diagnosticLogs / diagnosticEvents ─────────────────────────
  section("1. diagnosticLogs() + diagnosticEvents()");
  try {
    const logs = await sb.diagnosticLogs();
    console.log(`${logs.length} diagnostic log(s)`);
    for (const l of logs) console.log(`  ${l.name} (${l.size} bytes)`);

    const events = await sb.diagnosticEvents();
    console.log(`${events.length} diagnostic event(s)`);
    for (const e of events.slice(0, 3)) console.log(`  [${e.type}] ${e.message}`);
  } catch (e) {
    console.log(`  diagnostics not available on this server: ${(e as Error).message}`);
  }

  // ── Feature 2 — metrics() + watchMetrics() ───────────────────────────────
  section("2. metrics() one-shot + watchMetrics() streaming");
  try {
    const snap = await sb.metrics();
    console.log(
      `  metrics() → cpu=${snap.cpu?.toFixed(3) ?? "n/a"}  mem=${snap.memory?.toFixed(3) ?? "n/a"}`,
    );
  } catch (e) {
    console.log(`  metrics() not available on this server: ${(e as Error).message}`);
  }
  // watchMetrics() streams SSE from execd. Race a 3s timeout.
  let samples = 0;
  const metricsTimeout = new Promise<void>((r) => setTimeout(r, 3_000));
  const collectMetrics = async () => {
    for await (const m of sb.watchMetrics()) {
      console.log(`  watchMetrics() → cpu=${m.cpu?.toFixed(3)}  mem=${m.memory?.toFixed(3)}`);
      if (++samples >= 3) break;
    }
  };
  await Promise.race([collectMetrics(), metricsTimeout]);
  console.log(
    `  watchMetrics: ${samples} sample(s)${samples === 0 ? " (endpoint not streaming on this server)" : " ok"}`,
  );

  // ── Feature 3 — pause / resume ────────────────────────────────────────────
  section("3. pause() + resume()");
  await sb.exec("echo 'before-pause' > /tmp/marker");
  console.log("Pausing...");
  await sb.pause();
  console.log("Paused. Trying exec (should throw)...");
  try {
    await sb.exec("echo should-not-run");
    console.log("ERROR: exec should have thrown on paused sandbox");
  } catch (e) {
    console.log(`  Got expected error: ${(e as Error).message}`);
  }
  console.log("Resuming...");
  await sb.resume();
  console.log("Resumed.");
  const { stdout } = await sb.exec("cat /tmp/marker");
  console.log(`  File preserved across pause/resume: "${stdout.trim()}"`);

  // ── Feature 4 — BashSession ───────────────────────────────────────────────
  section("4. createSession() — persistent bash session");
  const session = await sb.createSession({ cwd: "/tmp" });
  console.log(`Session ID: ${session.sessionId}`);

  await session.exec("export GREETING=hello");
  const { stdout: greet } = await session.exec("echo $GREETING from session");
  console.log(`  Env persisted: "${greet.trim()}"`);

  await session.exec("cd /usr && export MYDIR=$(pwd)");
  const { stdout: dir } = await session.exec("echo $MYDIR");
  console.log(`  CWD persisted: "${dir.trim()}"`);

  await session.close();
  console.log("  Session closed.");
} finally {
  await sb.close();
  console.log("\nSandbox closed.");
}

// ── Feature 7 — Alineo.resume() ───────────────────────────────────────────────
section("7. Alineo.resume() — reconnect to a running agent");

const AGENT_SPEC_PATH = "../pi-agent/agents/hello-agent.json";
// Alineo.load() no longer does its own file I/O (see #184) -- read the spec ourselves.
// Alineo.resume() below still accepts a bare path via opts.specPath -- unchanged.
const agentSpec = await Bun.file(AGENT_SPEC_PATH).json();
const agent = await Alineo.load(agentSpec, { adapter });
const agentSandboxId = agent.sandboxId;
console.log(`Original agent sandbox: ${agentSandboxId}`);

// Send an initial prompt to establish session history.
process.stdout.write("Initial prompt: ");
for await (const chunk of agent.prompt("Remember the number 42. Just reply OK.")) {
  process.stdout.write(chunk);
}
console.log("\n");

// Simulate the host process exiting by NOT calling agent.close() — instead we
// forcibly kill the bridge inside the container, then reconnect via resume().
console.log("Simulating bridge crash (pkill)...");
await agent.sandbox.exec("pkill -f 'node /alineo-bridge.js' 2>/dev/null; true", { strict: false });

// Wait a moment so the process is fully dead.
await new Promise<void>((r) => setTimeout(r, 500));

const resumed = await Alineo.resume(agentSandboxId, {
  adapter,
  specPath: AGENT_SPEC_PATH,
});
console.log(`Resumed agent sandbox: ${resumed.sandboxId}`);

process.stdout.write("Resumed prompt: ");
for await (const chunk of resumed.prompt(
  "What number did I ask you to remember? Answer in one sentence.",
)) {
  process.stdout.write(chunk);
}
console.log("\n");

await resumed.close();
console.log("Resumed agent closed.");
