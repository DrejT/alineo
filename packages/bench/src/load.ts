import { summarize, type Summary } from "./stats.ts";

/** One unit of work in a ramp. Return named phase timings (ms); throw to record a failure. */
export type Task = (index: number) => Promise<Record<string, number>>;

export interface LevelResult {
  /** Number of tasks launched simultaneously at this level. */
  concurrency: number;
  ok: number;
  failed: number;
  errorRate: number;
  /** Wall time for the whole burst, ms. */
  wallMs: number;
  /** Per-phase latency summaries over successful tasks. */
  phases: Record<string, Summary>;
  /** Distinct failure messages with counts, so infra errors aren't read as slowness. */
  errors: Record<string, number>;
}

export interface RampOptions {
  levels: readonly number[];
  /** Stop climbing once a level's error rate exceeds this (0-1). Default 0.2. */
  maxErrorRate?: number;
  /** Awaited before each level; throw to abort the ramp (e.g. Docker went away). */
  beforeLevel?: (concurrency: number) => Promise<void>;
  onLevel?: (result: LevelResult) => void;
}

export interface RampResult {
  levels: LevelResult[];
  /** Highest level that stayed under the error-rate ceiling, or undefined if none did. */
  lastHealthy?: number;
  /** First level that crossed the ceiling, i.e. the knee. */
  firstUnhealthy?: number;
  abortedBy?: string;
}

export async function runLevel(concurrency: number, task: Task): Promise<LevelResult> {
  const t0 = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, (_, i) => task(i)));
  const wallMs = performance.now() - t0;

  const samples: Record<string, number[]> = {};
  const errors: Record<string, number> = {};
  let ok = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      ok++;
      for (const [k, v] of Object.entries(s.value)) (samples[k] ??= []).push(v);
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      const key = msg.slice(0, 160);
      errors[key] = (errors[key] ?? 0) + 1;
    }
  }
  const failed = concurrency - ok;
  return {
    concurrency,
    ok,
    failed,
    errorRate: concurrency === 0 ? 0 : failed / concurrency,
    wallMs,
    phases: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summarize(v)])),
    errors,
  };
}

/** Climb through `levels`, one burst per level, stopping at the knee. */
export async function ramp(task: Task, opts: RampOptions): Promise<RampResult> {
  const ceiling = opts.maxErrorRate ?? 0.2;
  const out: RampResult = { levels: [] };
  for (const n of opts.levels) {
    try {
      await opts.beforeLevel?.(n);
    } catch (e) {
      out.abortedBy = e instanceof Error ? e.message : String(e);
      break;
    }
    const res = await runLevel(n, task);
    out.levels.push(res);
    opts.onLevel?.(res);
    if (res.errorRate > ceiling) {
      out.firstUnhealthy = n;
      break;
    }
    out.lastHealthy = n;
  }
  return out;
}
