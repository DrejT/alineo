/**
 * Measure what checkpoints and restores cost with many agents at once (durability-roadmap M4, 4.0).
 *
 *   bun apps/alineod/scripts/checkpoint-load.ts [--agents 1,5,10,20] [--mb 20]
 *                                              [--checkpoint-concurrency N] [--restore-concurrency N]
 *
 * For each agent count N it starts N sandboxes, puts `--mb` MB of incompressible data in each
 * one's /workspace, checkpoints all N at the same instant through the same limiter alineod uses,
 * then removes every container and restores all N. It prints one table row per N: peak memory of
 * this process (standing in for alineod: it is the process that holds the tarballs), the time to
 * checkpoint all N, and the time to restore all N.
 *
 * Run it twice with `--restore-concurrency 1` and a larger value to see what parallel restore buys.
 * No model is called, so no model key is needed. Needs OpenSandbox and Docker, like
 * tests/integration/checkpoint-restore.test.ts. It starts real containers, so it is a tool to run
 * by hand on the box you want a number for, not part of the test suite.
 */
import { Alineo, checkpointsPath, takeCheckpoint } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_CONCURRENCY, REHYDRATE_CONCURRENCY } from "../config";
import { createLimiter, mapLimit } from "../src/util";

function numberList(raw: string): number[] {
  const out = raw.split(",").map((v) => Number(v.trim()));
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`bad number list: ${raw}`);
  return out;
}

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const counts = numberList(opt("--agents") ?? "1,5,10,20");
const mb = Number(opt("--mb") ?? "20");
const checkpointConcurrency = Number(opt("--checkpoint-concurrency") ?? CHECKPOINT_CONCURRENCY);
const restoreConcurrency = Number(opt("--restore-concurrency") ?? REHYDRATE_CONCURRENCY);
if (![mb, checkpointConcurrency, restoreConcurrency].every((n) => Number.isFinite(n) && n > 0)) {
  console.error("--mb and both concurrency options must be positive numbers");
  process.exit(2);
}

const SPEC = {
  harness: "pi" as const,
  harnessVersion: "1.2.0",
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
  env: { NVIDIA_API_KEY: "not-used-no-turn-runs" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

function removeContainer(sandboxId: string): void {
  const ps = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `name=${sandboxId}`]);
  const ids = ps.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ids]);
}

const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0);
const secs = (ms: number): string => (ms / 1000).toFixed(1);

console.log(
  `payload ${mb} MB per agent, checkpoint concurrency ${checkpointConcurrency}, ` +
    `restore concurrency ${restoreConcurrency}\n`,
);
console.log("| agents | RSS before (MB) | peak RSS (MB) | checkpoint all (s) | restore all (s) |");
console.log("|---|---|---|---|---|");

for (const n of counts) {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-load-"));
  const ledger = join(dir, "ledger.db");
  const adapter = new SQLiteAdapter(ledger);
  const specs = Array.from({ length: n }, (_, i) => ({ ...SPEC, name: `load-${n}-${i}` }));
  const live: Alineo[] = [];
  try {
    // Provisioning is not what is measured, and it is heavy, so it is paced.
    await mapLimit(specs, 2, async (spec) => {
      const agent = await Alineo.start(spec, { adapter });
      await agent.sandbox.exec(
        `mkdir -p /workspace && head -c ${Math.round(mb * 1024 * 1024)} /dev/urandom > /workspace/payload.bin`,
      );
      live.push(agent);
    });

    const rssBefore = process.memoryUsage().rss;
    let peak = rssBefore;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);

    const slot = createLimiter(checkpointConcurrency);
    const t0 = Date.now();
    await Promise.all(
      live.map((agent) =>
        slot(() => takeCheckpoint(agent.sandbox, checkpointsPath(ledger), { turn: 1 })),
      ),
    );
    const checkpointMs = Date.now() - t0;
    clearInterval(sampler);

    const ids = live.map((a) => a.sandboxId);
    const names = new Map(live.map((a) => [a.sandboxId, a.name]));
    for (const id of ids) removeContainer(id);
    live.length = 0;

    const t1 = Date.now();
    await mapLimit(ids, restoreConcurrency, async (id) => {
      const spec = specs.find((s) => s.name === names.get(id));
      live.push(await Alineo.resume(id, { adapter, spec }));
    });
    const restoreMs = Date.now() - t1;

    console.log(
      `| ${n} | ${mib(rssBefore)} | ${mib(peak)} | ${secs(checkpointMs)} | ${secs(restoreMs)} |`,
    );
  } finally {
    for (const agent of live) await agent.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
