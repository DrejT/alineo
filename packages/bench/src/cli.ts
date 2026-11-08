/**
 * Usage: bun src/cli.ts <provision|fork> [--levels 1,5,10,25] [--out results] [--max-error-rate 0.2]
 * Env:   OPEN_SANDBOX_URL, OPEN_SANDBOX_API_KEY, USE_SERVER_PROXY, BENCH_IMAGE, BENCH_CPU, BENCH_MEMORY
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { ramp, type Task } from "./load.ts";
import { assertDockerHealthy, collectManifest } from "./manifest.ts";
import { renderMarkdown, writeResults } from "./report.ts";
import { forkTask } from "./scenarios/fork.ts";
import { provisionTask } from "./scenarios/provision.ts";
import { installHostRewrite } from "./transport.ts";

installHostRewrite(process.env.BENCH_REWRITE_HOST);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const scenario = process.argv[2];
if (scenario !== "provision" && scenario !== "fork") {
  console.error(
    "usage: bench <provision|fork> [--levels 1,5,10] [--out results] [--max-error-rate 0.2]",
  );
  process.exit(2);
}

const levels = arg("levels", "1,5,10").split(",").map(Number);
const opts = {
  image: process.env.BENCH_IMAGE ?? "ubuntu:22.04",
  cpu: process.env.BENCH_CPU ?? "500m",
  memory: process.env.BENCH_MEMORY ?? "512Mi",
};
const maxErrorRate = Number(arg("max-error-rate", "0.2"));

assertDockerHealthy();
const manifest = collectManifest({ scenario, levels, maxErrorRate, ...opts });
const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter(":memory:"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

let cleanup: (() => Promise<void>) | undefined;
let task: Task;
if (scenario === "provision") {
  task = provisionTask(client, opts);
} else {
  const f = await forkTask(client, opts);
  task = f.task;
  cleanup = f.close;
}

try {
  const result = await ramp(task, {
    levels,
    maxErrorRate,
    beforeLevel: async (n) => {
      assertDockerHealthy();
      console.log(`level N=${n} ...`);
    },
    onLevel: (r) => console.log(`  ok=${r.ok} fail=${r.failed} wall=${r.wallMs.toFixed(0)}ms`),
  });
  const dir = writeResults(arg("out", "results"), scenario, manifest, result);
  console.log("\n" + renderMarkdown(scenario, manifest, result));
  console.log(`wrote ${dir}`);
} finally {
  await cleanup?.();
}
