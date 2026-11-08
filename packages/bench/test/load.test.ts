import { describe, expect, it } from "vitest";
import { ramp, runLevel } from "../src/load.ts";
import { renderMarkdown } from "../src/report.ts";

describe("runLevel", () => {
  it("summarizes phases over successes and groups failures", async () => {
    const r = await runLevel(10, async (i) => {
      if (i < 3) throw new Error("boom");
      return { work: i };
    });
    expect(r.ok).toBe(7);
    expect(r.failed).toBe(3);
    expect(r.errorRate).toBeCloseTo(0.3);
    expect(r.errors["boom"]).toBe(3);
    expect(r.phases.work!.count).toBe(7);
  });
});

describe("ramp", () => {
  it("stops at the knee and reports it", async () => {
    let level = 0;
    const res = await ramp(
      async () => {
        if (level >= 10) throw new Error("capacity");
        return { t: 1 };
      },
      {
        levels: [1, 5, 10, 25],
        maxErrorRate: 0.1,
        beforeLevel: async (n) => {
          level = n;
        },
      },
    );
    expect(res.lastHealthy).toBe(5);
    expect(res.firstUnhealthy).toBe(10);
    expect(res.levels.map((l) => l.concurrency)).toEqual([1, 5, 10]);
  });
  it("aborts when the guard throws", async () => {
    const res = await ramp(async () => ({ t: 1 }), {
      levels: [1, 2],
      beforeLevel: async (n) => {
        if (n === 2) throw new Error("Docker is not responding");
      },
    });
    expect(res.lastHealthy).toBe(1);
    expect(res.abortedBy).toMatch(/Docker/);
  });
  it("renders a report with the knee", async () => {
    const res = await ramp(async () => ({ t: 5 }), { levels: [2] });
    // A literal manifest: collectManifest() shells out to `docker info`, which a unit test must not need.
    const manifest = {
      runId: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      gitSha: null,
      host: { platform: "test", release: "0", cpuModel: "cpu", cpus: 1, totalMemGiB: 1 },
      docker: null,
      runtime: { bun: null, node: "v0" },
      params: {},
    };
    const md = renderMarkdown("demo", manifest, res);
    expect(md).toContain("## t (ms)");
    expect(md).toContain("Last healthy level: 2");
  });
});
