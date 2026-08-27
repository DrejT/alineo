/**
 * Demonstrates sb.fork():
 *   Install dependencies once, then branch into two independent sandboxes
 *   that run different workloads in parallel from the same base state.
 *
 * Both forks share the pip install — neither has to repeat it.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const scriptA = `
import numpy as np
a = np.arange(1_000_000).reshape(1000, 1000)
result = np.trace(a)
print(f"[track-a] trace = {result}")
`.trim();

const scriptB = `
import numpy as np
a = np.arange(1_000_000).reshape(1000, 1000)
result = np.sum(np.diag(a))
print(f"[track-b] diag sum = {result}")
`.trim();

// ── Base sandbox: install once ────────────────────────────────────────────────

console.log("=== Installing dependencies ===\n");

const sb = await client.sandbox({
  image: "python:3.11-slim",
  resources: { cpu: "1", memory: "512Mi" },
  name: "fork-demo",
});

let forkA: Awaited<ReturnType<typeof sb.fork>> | undefined;
let forkB: Awaited<ReturnType<typeof sb.fork>> | undefined;

try {
  await sb.exec("pip install -q numpy && echo 'numpy ready'").pipe(process.stdout);

  // ── Fork into two independent sandboxes ────────────────────────────────────

  console.log("\n=== Forking into two tracks ===\n");

  // Promise.allSettled, not Promise.all: if one fork() rejects, the other may still have
  // succeeded server-side. allSettled lets us capture whichever handle(s) actually came back
  // (so `finally` below closes them, not orphans them) before surfacing the failure.
  const forkResults = await Promise.allSettled([sb.fork("track-a"), sb.fork("track-b")]);
  if (forkResults[0].status === "fulfilled") forkA = forkResults[0].value;
  if (forkResults[1].status === "fulfilled") forkB = forkResults[1].value;
  const forkFailures = forkResults.filter((r) => r.status === "rejected");
  if (forkFailures.length > 0) {
    throw new Error(
      `${forkFailures.length}/2 fork() calls failed: ` +
        forkFailures
          .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
          .join("; "),
    );
  }
  // No failures above means both fork() calls fulfilled, so both handles were assigned.
  if (!forkA || !forkB) {
    throw new Error("internal error: fork() succeeded but a handle is missing");
  }
  const a = forkA;
  const b = forkB;

  console.log(`fork-a id: ${a.sandboxId}`);
  console.log(`fork-b id: ${b.sandboxId}`);

  // ── Run different workloads in parallel ────────────────────────────────────

  console.log("\n=== Running in parallel ===\n");

  await Promise.all([
    a
      .writeFile("/tmp/run.py", scriptA)
      .then(() => a.exec("python3 /tmp/run.py").pipe(process.stdout)),
    b
      .writeFile("/tmp/run.py", scriptB)
      .then(() => b.exec("python3 /tmp/run.py").pipe(process.stdout)),
  ]);

  // ── Checkpoints are recorded in the original sandbox's ledger ─────────────

  const checkpoints = await sb.listCheckpoints();
  console.log(`\nCheckpoints on original sandbox: ${checkpoints.length}`);
  for (const cp of checkpoints) {
    console.log(`  ${cp.tag} → ${cp.snapshotId}`);
  }
} finally {
  await Promise.all([forkA?.close(), forkB?.close(), sb.close()]);
}
