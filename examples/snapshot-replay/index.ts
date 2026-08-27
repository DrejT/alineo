/**
 * Demonstrates checkpoint + resume:
 *   Pattern A — sb.checkpoint() + client.resume(sandboxId)
 *
 * The first run installs deps and checkpoints. The resume skips the install
 * (replayed from ledger cache) and runs the test script on the restored container.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sandboxOpts = {
  image: "python:3.11-slim",
  resources: { cpu: "1", memory: "512Mi" },
  name: "snapshot-replay",
};

const script = `
import sys
print(f"Python {sys.version.split()[0]}")
`.trim();

const replayScript = `
import sys
print(f"Python {sys.version.split()[0]} (replayed)")
print("requests is already installed — no pip install needed")
`.trim();

// ── Original run ─────────────────────────────────────────────────────────────

console.log("=== Original run ===\n");

const sb = await client.sandbox(sandboxOpts);
let originalSandboxId: string | undefined;

try {
  originalSandboxId = sb.sandboxId;
  console.log(`SandboxHandle ID: ${originalSandboxId}`);

  await sb.exec("pip install -q requests && echo 'installed'").pipe(process.stdout);
  await sb.checkpoint("after-install");
  console.log("checkpoint created");

  await sb.writeFile("/tmp/script.py", script);
  await sb.exec("python3 /tmp/script.py").pipe(process.stdout);
} finally {
  await sb.close();
}

// ── Resumed run ──────────────────────────────────────────────────────────────

console.log("\n=== Resumed run ===\n");

// The try block above always assigns originalSandboxId before completing without
// throwing — if it threw, we wouldn't reach here at all.
if (!originalSandboxId) throw new Error("internal error: originalSandboxId was never set");
const sbResume = await client.resume(originalSandboxId);

try {
  console.log(`Resumed sandbox ID: ${sbResume.sandboxId}`);

  // This exec is replayed from cache — returns immediately without running
  const { stdout } = await sbResume.exec("pip install -q requests && echo 'installed'");
  console.log("(replayed from cache):", stdout.trim());

  // This exec actually runs on the restored container
  await sbResume.writeFile("/tmp/script.py", replayScript);
  await sbResume.exec("python3 /tmp/script.py").pipe(process.stdout);
} finally {
  await sbResume.close();
}
