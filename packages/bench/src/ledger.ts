/**
 * Ledger throughput: how fast the storage adapters append events and replay a session.
 *
 * Measures SQLite (synchronous = FULL, the durable setting the adapter pins) and Postgres (a temporary
 * container), at three write concurrencies and two payload sizes, plus replay time for large sessions.
 *
 * Usage: bun src/ledger.ts [--events 5000] [--out results] [--no-postgres]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerEvent, type IStorageAdapter, type LedgerEntry } from "../../core/src/ledger.ts";
import { PostgresAdapter } from "../../adapters/postgres/src/adapter.ts";
import { SQLiteAdapter } from "../../adapters/sqlite/src/adapter.ts";
import { collectManifest } from "./manifest.ts";
import { summarize } from "./stats.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const EVENTS = Number(arg("events", "5000"));
const SESSIONS = 50;

const entry = (i: number, bytes: number): LedgerEntry => ({
  ts: Date.now() + i,
  name: "bench",
  sandboxId: `sb-${i % SESSIONS}`,
  stepIndex: Math.floor(i / SESSIONS),
  event: LedgerEvent.ExecStart,
  payload: { cmd: "echo hello", pad: "x".repeat(bytes) },
});

/** Run `total` appends with `concurrency` writers in flight; returns per-op latencies and wall time. */
async function appendLoad(
  a: IStorageAdapter,
  total: number,
  concurrency: number,
  bytes: number,
  offset: number,
) {
  const lat: number[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = next++; i < total; i = next++) {
        const s = performance.now();
        await a.append(entry(offset + i, bytes));
        lat.push(performance.now() - s);
      }
    }),
  );
  const wall = performance.now() - t0;
  return { opsPerSec: total / (wall / 1000), wallMs: wall, latency: summarize(lat) };
}

interface Row {
  adapter: string;
  payloadBytes: number;
  concurrency: number;
  events: number;
  opsPerSec: number;
  p50: number;
  p95: number;
  p99: number;
}

async function benchAdapter(name: string, a: IStorageAdapter) {
  await a.connect?.();
  const rows: Row[] = [];
  let offset = 0;
  for (const bytes of [100, 2000]) {
    for (const c of [1, 8, 32]) {
      const r = await appendLoad(a, EVENTS, c, bytes, offset);
      offset += EVENTS;
      rows.push({
        adapter: name,
        payloadBytes: bytes,
        concurrency: c,
        events: EVENTS,
        opsPerSec: r.opsPerSec,
        p50: r.latency.p50,
        p95: r.latency.p95,
        p99: r.latency.p99,
      });
      console.log(
        `${name} payload=${bytes}B c=${c}: ${r.opsPerSec.toFixed(0)} ops/s p50=${r.latency.p50.toFixed(1)}ms p95=${r.latency.p95.toFixed(1)}ms p99=${r.latency.p99.toFixed(1)}ms`,
      );
    }
  }
  // Replay: one session with many events, so readAll has real work to do.
  const big = "bench-big";
  const N = [1000, 10_000, 50_000];
  const replay: { events: number; ms: number }[] = [];
  let have = 0;
  for (const n of N) {
    const batch: Promise<void>[] = [];
    for (let i = have; i < n; i++) {
      batch.push(a.append({ ...entry(i, 100), name: big, sandboxId: "big" }));
      if (batch.length >= 64) await Promise.all(batch.splice(0));
    }
    await Promise.all(batch);
    have = n;
    const t0 = performance.now();
    const all = await a.readAll(big, "big");
    const ms = performance.now() - t0;
    replay.push({ events: all.length, ms });
    console.log(`${name} replay of ${all.length} events: ${ms.toFixed(0)} ms`);
  }
  await a.close?.();
  return { rows, replay };
}

async function withPostgres<T>(fn: (conn: string) => Promise<T>): Promise<T> {
  const name = `bench-pg-${Date.now()}`;
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=bench",
      "-p",
      "55432:5432",
      "postgres:16-alpine",
    ],
    { stdio: "ignore", timeout: 240_000 },
  );
  try {
    for (let i = 0; i < 60; i++) {
      try {
        execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], {
          stdio: "ignore",
          timeout: 10_000,
        });
        // The image restarts once during init; give it a moment, then confirm again.
        await new Promise((r) => setTimeout(r, 3000));
        execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], {
          stdio: "ignore",
          timeout: 10_000,
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return await fn("postgres://postgres:bench@127.0.0.1:55432/postgres");
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
    } catch {
      // best effort
    }
  }
}

const manifest = collectManifest({
  scenario: "ledger-throughput",
  events: EVENTS,
  sqliteSynchronous: "FULL",
});
const dbDir = join(tmpdir(), `bench-ledger-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
const results: Record<string, unknown> = {};
try {
  results["sqlite"] = await benchAdapter("sqlite", new SQLiteAdapter(join(dbDir, "ledger.db")));
  if (!process.argv.includes("--no-postgres")) {
    results["postgres"] = await withPostgres((conn) =>
      benchAdapter("postgres", new PostgresAdapter(conn)),
    );
  }
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}
const dir = join(arg("out", "results"), `ledger-${manifest.runId}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, "result.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${dir}`);
