/**
 * Demonstrates sandbox environments: build once, restore fast.
 *
 * First run installs Python packages into a sandbox and snapshots it.
 * Second run restores from the snapshot — setup is skipped entirely.
 *
 * Run twice to see the difference:
 *   bun examples/environments/index.ts   # ~30–60 s (build + snapshot)
 *   bun examples/environments/index.ts   # ~2–3 s  (restore from snapshot)
 */

import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const env = client.environment("python-data-science", {
  image: "python:3.11-slim",
  resources: { cpu: "500m", memory: "512Mi" },
  setup: async (sb) => {
    console.log("  Running setup (install packages)...");
    await sb.exec("pip install --quiet numpy pandas");
    console.log("  Setup complete.");
  },
});

const existing = await env.info();
if (existing) {
  console.log(
    `Environment cached (built ${new Date(existing.builtAt).toISOString()}, snapshot ${existing.snapshotId})`,
  );
} else {
  console.log("No cached environment — will build on first sandbox() call.");
}

console.log("\nSpawning sandbox from environment...");
const t0 = Date.now();
const sb = await env.sandbox();
console.log(`Ready in ${Date.now() - t0}ms  (sandbox ${sb.sandboxId})`);

try {
  console.log(
    '\n$ python3 -c "import numpy, pandas; print(numpy.__version__, pandas.__version__)"',
  );
  await sb
    .exec('python3 -c "import numpy, pandas; print(numpy.__version__, pandas.__version__)"')
    .pipe(process.stdout);
} finally {
  await sb.close();
}

console.log("\nDone. Run again to see snapshot restore speed.");
