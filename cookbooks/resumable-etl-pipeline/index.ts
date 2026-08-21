/**
 * Recipe: a multi-stage ETL pipeline that can pick up where it left off.
 *
 * Each stage checkpoints on completion. If the process crashes — or you just
 * want to re-run the "load" stage without paying for extract/transform again —
 * `client.resume(sandboxId)` restores the container from the last checkpoint.
 * The restored container's filesystem already has extract/transform's output
 * on it, and each exec() call after resume replays from the ledger by
 * position — the Nth call returns the Nth original call's result, regardless
 * of what command is actually passed — so re-issue calls in the same order
 * as the original run.
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
  name: "resumable-etl",
};

const transformScript = [
  "import pandas as pd",
  "",
  "df = pd.read_csv('/workspace/raw.csv')",
  "df['revenue'] = df['units'] * df['price']",
  "out = df.groupby('region')['revenue'].sum().reset_index()",
  "out.to_csv('/workspace/transformed.csv', index=False)",
  "print(out.to_string(index=False))",
].join("\n");

console.log("=== Original run ===\n");

const sb = await client.sandbox(sandboxOpts);
const sandboxId = sb.sandboxId;
console.log(`SandboxHandle ID: ${sandboxId}`);

try {
  // ── Extract ────────────────────────────────────────────────────────────
  console.log("\n[extract] installing pandas + writing raw data...");
  await sb.exec("pip install --quiet pandas");
  await sb.writeFile(
    "/workspace/raw.csv",
    ["region,units,price", "west,10,4.5", "east,7,4.5", "west,3,4.5", "east,12,4.5"].join("\n"),
  );
  await sb.checkpoint("after-extract");
  console.log("[extract] checkpoint: after-extract");

  // ── Transform ──────────────────────────────────────────────────────────
  console.log("\n[transform] aggregating revenue by region...");
  await sb.writeFile("/workspace/transform.py", transformScript);
  await sb.exec("python3 /workspace/transform.py").pipe(process.stdout);
  await sb.checkpoint("after-transform");
  console.log("[transform] checkpoint: after-transform");

  // ── Load ───────────────────────────────────────────────────────────────
  console.log("\n[load] publishing results...");
  const result = await sb.readFile("/workspace/transformed.csv");
  console.log("[load] final output:\n" + result);
} finally {
  await sb.close();
}

// ── Resumed run — e.g. after a crash, or just re-running the "load" stage ──

console.log("\n=== Resumed run (skips extract + transform) ===\n");

const resumed = await client.resume(sandboxId);

try {
  console.log(`Resumed sandbox ID: ${resumed.sandboxId}`);

  // This is the first exec() call since resume, so it replays the original run's
  // first exec() result (the extract stage's pip install) from the ledger — by
  // position, not by matching this command's text. Re-issuing the same command
  // here is good practice for readability, not something the SDK checks for.
  const t0 = Date.now();
  await resumed.exec("pip install --quiet pandas");
  console.log(`[extract] (replayed) pip install — ${Date.now() - t0}ms`);

  // transformed.csv is already on the restored container's filesystem — the
  // transform stage doesn't need to run again.
  const result = await resumed.readFile("/workspace/transformed.csv");
  console.log("[load] (live) re-publishing from restored state:\n" + result);
} finally {
  await resumed.close();
}
