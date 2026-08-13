/**
 * Times the sandbox substrate's cold-start and steady-state phases:
 * provisioning (create → Running), first exec (execd readiness poll +
 * round trip), warm exec (round trip only), and checkpoint.
 *
 * Usage: bun index.ts [iterations]
 * Env: OPEN_SANDBOX_URL, OPEN_SANDBOX_API_KEY, USE_SERVER_PROXY, BENCH_IMAGE
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter(":memory:"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const iterations = Number(process.argv[2] ?? 5);
const image = process.env.BENCH_IMAGE ?? "ubuntu:22.04";
const cpu = process.env.BENCH_CPU ?? "500m";
const memory = process.env.BENCH_MEMORY ?? "512Mi";

interface Row {
  provisionMs: number;
  firstExecMs: number;
  warmExecMs: number;
  checkpointMs: number;
}

const rows: Row[] = [];

for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  const sb = await client.sandbox({
    image,
    resources: { cpu, memory },
    name: `bench-${i}`,
  });
  const t1 = performance.now();

  await sb.exec("true");
  const t2 = performance.now();

  await sb.exec("true");
  const t3 = performance.now();

  await sb.checkpoint();
  const t4 = performance.now();

  await sb.close();

  const row: Row = {
    provisionMs: t1 - t0,
    firstExecMs: t2 - t1,
    warmExecMs: t3 - t2,
    checkpointMs: t4 - t3,
  };
  rows.push(row);

  console.log(
    `[${i + 1}/${iterations}] provision=${row.provisionMs.toFixed(0)}ms ` +
      `first-exec=${row.firstExecMs.toFixed(0)}ms warm-exec=${row.warmExecMs.toFixed(0)}ms ` +
      `checkpoint=${row.checkpointMs.toFixed(0)}ms`,
  );
}

function stats(values: number[]): { min: number; max: number; avg: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, avg };
}

console.log("\n--- summary ---");
for (const key of ["provisionMs", "firstExecMs", "warmExecMs", "checkpointMs"] as const) {
  const { min, max, avg } = stats(rows.map((r) => r[key]));
  console.log(
    `${key.replace("Ms", "")}: avg=${avg.toFixed(0)}ms min=${min.toFixed(0)}ms max=${max.toFixed(0)}ms`,
  );
}
