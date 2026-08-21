/**
 * Demonstrates resource cleanup and error handling patterns:
 *   Pattern A — try/finally ensures sb.close() always runs
 *   Pattern B — bash-level timeout via the `timeout` command
 *   Pattern C — CommandError from a non-zero exit
 */
import { Sandbox, CommandError } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const image = "ubuntu:22.04";
const resources = { cpu: "500m", memory: "256Mi" };

// ── Pattern A: try/finally for cleanup ───────────────────────────────────────

console.log("=== Pattern A: try/finally ===");

const sbA = await client.sandbox({ image, resources, name: "cancellation-a" });
try {
  await sbA.exec("echo 'starting...'").pipe(process.stdout);
  await sbA.exec("echo 'done'").pipe(process.stdout);
} finally {
  await sbA.close();
  console.log("sandbox closed\n");
}

// ── Pattern B: bash-level timeout ────────────────────────────────────────────

console.log("=== Pattern B: bash timeout command ===");

const sbB = await client.sandbox({ image, resources, name: "cancellation-b" });
try {
  // timeout(1) wraps sleep(30) — exits after 1 second
  const { exitCode } = await sbB.exec("timeout 1 sleep 30 || echo 'timed out'", { strict: false });
  await sbB.exec(`echo "exit code: ${exitCode}"`).pipe(process.stdout);
} finally {
  await sbB.close();
}

// ── Pattern C: CommandError from non-zero exit ────────────────────────────────

console.log("\n=== Pattern C: CommandError ===");

const sbC = await client.sandbox({ image, resources, name: "cancellation-c" });
try {
  await sbC.exec("echo 'step 1'").pipe(process.stdout);
  await sbC.exec("exit 1"); // throws CommandError
} catch (e) {
  if (e instanceof CommandError) {
    console.log(`caught CommandError: exit ${e.exitCode}`);
  } else throw e;
} finally {
  await sbC.close();
}
