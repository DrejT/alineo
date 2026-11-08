import { describe, expect, it } from "vitest";
import {
  buildRepo,
  CLEAN_FILE,
  FIXTURES,
  parseFindings,
  scoreReview,
} from "../src/review-suite.ts";

describe("review fixtures", () => {
  const { files, bugs } = buildRepo();
  it("seeds exactly two bugs per module (12 in total) and none in the clean file", () => {
    expect(bugs).toHaveLength(FIXTURES.length * 2);
    expect(bugs.filter((b) => b.file === CLEAN_FILE.file)).toHaveLength(0);
    for (const f of FIXTURES) expect(bugs.filter((b) => b.file === f.file)).toHaveLength(2);
  });
  it("never shows the agent a BUG marker, and every bug line is a real line of the file", () => {
    for (const body of Object.values(files)) expect(body).not.toMatch(/# BUG/);
    for (const b of bugs) expect(b.line).toBeLessThanOrEqual(files[b.file]!.split("\n").length);
  });
  it("the fixed version of each module differs from the buggy one", () => {
    for (const f of FIXTURES) expect(f.fixed).not.toBe(files[f.file]);
  });
});

describe("scoring a review by code", () => {
  const { bugs } = buildRepo();
  it("a perfect review scores recall 1 and precision 1", () => {
    const s = scoreReview(
      bugs.map((b) => ({ file: b.file, line: b.line })),
      bugs,
    );
    expect(s).toMatchObject({ recall: 1, precision: 1, found: 12, falsePositivesOnCleanFile: 0 });
  });
  it("an empty review scores 0 recall, and hallucinated findings score 0 precision", () => {
    expect(scoreReview([], bugs).recall).toBe(0);
    const s = scoreReview(
      [
        { file: "inventory.py", line: 999 },
        { file: "nope.py", line: 1 },
      ],
      bugs,
    );
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
  });
  it("allows a line tolerance of 2 but not more, and credits each bug only once", () => {
    const b = bugs[0]!;
    expect(scoreReview([{ file: b.file, line: b.line + 2 }], bugs).found).toBe(1);
    expect(scoreReview([{ file: b.file, line: b.line + 3 }], bugs).found).toBe(0);
    const dup = scoreReview(
      [
        { file: b.file, line: b.line },
        { file: b.file, line: b.line },
      ],
      bugs,
    );
    expect(dup.found).toBe(1);
    expect(dup.precision).toBe(0.5); // the repeat is a false positive
  });
  it("counts findings on the clean file as false alarms", () => {
    const s = scoreReview([{ file: CLEAN_FILE.file, line: 3 }], bugs);
    expect(s.falsePositivesOnCleanFile).toBe(1);
    expect(s.precision).toBe(0);
  });
});

describe("parsing the agent's review.json", () => {
  it("accepts a plain array, a fenced array and string line numbers", () => {
    expect(parseFindings('[{"file":"a.py","line":3,"issue":"x"}]')).toEqual([
      { file: "a.py", line: 3, issue: "x" },
    ]);
    expect(parseFindings('```json\n[{"file":"/tmp/work/repo/a.py","line":"4"}]\n```')).toEqual([
      { file: "a.py", line: 4 },
    ]);
  });
  it("returns nothing for garbage instead of throwing", () => {
    expect(parseFindings("no findings here")).toEqual([]);
    expect(parseFindings("[not json")).toEqual([]);
    expect(parseFindings('[{"file":"a.py"}]')).toEqual([]);
  });
});
