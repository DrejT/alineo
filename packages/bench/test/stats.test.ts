import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../src/stats.ts";

describe("stats", () => {
  it("uses nearest-rank percentiles", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile(v, 100)).toBe(100);
  });
  it("handles a single value and empty input", () => {
    expect(summarize([7]).p99).toBe(7);
    expect(summarize([]).count).toBe(0);
    expect(summarize([]).p50).toBeNaN();
  });
  it("does not mutate its input", () => {
    const v = [3, 1, 2];
    summarize(v);
    expect(v).toEqual([3, 1, 2]);
  });
});
