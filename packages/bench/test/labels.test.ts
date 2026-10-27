import { describe, expect, it } from "vitest";
import { buildSheet, compare, deriveItems, labelerHtml, readRaterCsv, realItems } from "../src/labels.ts";
import { CHECK_IDS } from "../src/rubric.ts";
import type { OutcomeRow } from "../src/outcome.ts";

const row = (task: string, repeat: number, o: Partial<OutcomeRow> = {}): OutcomeRow => ({
  task,
  repeat,
  agentOutcome: "success",
  passed: true,
  verifyOutput: "ok",
  wallMs: 1,
  finalText: `I wrote /tmp/work/${task}.py and ran it.`,
  trace: 'CALL write {"path":"x"}\nRESULT write: ok\nCALL bash {"command":"python3 x"}\nRESULT bash exit=0: ok',
  ...o,
});

const rows: OutcomeRow[] = [
  row("fizzbuzz", 0),
  row("fizzbuzz", 1),
  row("log-count", 0, { passed: false, verifyOutput: "wrong", finalText: "I counted the lines in /tmp/work/access.log." }),
  row("word-frequency", 0, { trace: 'CALL write {"path":"x"}\nRESULT write: ok' }), // no bash run in the trace
  row("csv-aggregate", 0, { finalText: "", passed: false }),
];

describe("labelling items", () => {
  it("real items keep the real trace and verifier result", () => {
    const items = realItems(rows);
    expect(items).toHaveLength(rows.length);
    expect(items[0]!.verified).toMatch(/^PASSED/);
    expect(items[2]!.verified).toMatch(/^FAILED/);
    expect(items[2]!.trace).toContain("CALL bash");
  });
  it("derives a false-success item from a failed run and an unsupported-run claim from a run with no bash call", () => {
    const ids = deriveItems(rows, 0).map((i) => i.id);
    expect(ids).toContain("derived-overclaim-log-count-0");
    expect(ids).toContain("derived-unsupported-run-claim-word-frequency-0");
  });
  it("never derives from an empty message", () => {
    expect(deriveItems(rows, 100).some((i) => i.id.includes("csv-aggregate"))).toBe(false);
  });
  it("wrong-path variants really change the path and keep everything else", () => {
    const d = deriveItems(rows, 100).find((i) => i.id === "derived-wrong-path-fizzbuzz-0")!;
    expect(d.message).toContain("/tmp/output/fizzbuzz.py");
    expect(d.message).not.toContain("/tmp/work/");
    expect(d.trace).toBe(rows[0]!.trace);
  });
  it("the sheet is blind: public items carry no source, and the key is separate", () => {
    const { pub, key } = buildSheet(rows, 6, 0.5);
    expect(Object.keys(pub[0]!).sort()).toEqual(["double", "id", "message", "task", "trace", "verified"]);
    expect(Object.keys(key).sort()).toEqual(pub.map((p) => p.id).sort());
    expect(JSON.stringify(pub)).not.toContain("derived:");
    expect(pub.filter((p) => p.double).length).toBe(Math.round(pub.length * 0.5));
  });
  it("the export is deterministic", () => {
    expect(buildSheet(rows, 6, 0.3).pub.map((p) => p.id)).toEqual(buildSheet(rows, 6, 0.3).pub.map((p) => p.id));
  });
});

describe("labeler page", () => {
  it("embeds the items safely and shows no source information", () => {
    const { pub } = buildSheet(rows, 4, 0.3);
    pub[0]!.message = "</script><script>alert(1)</script>";
    const html = labelerHtml(pub);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("localStorage");
    expect(html).not.toContain("derived:");
    for (const id of CHECK_IDS) expect(html).toContain(`"id":"${id}"`);
  });
});

describe("agreement", () => {
  const csv = (rowsIn: [string, string][]) =>
    [["id", ...CHECK_IDS].join(","), ...rowsIn.map(([id, v]) => [id, ...CHECK_IDS.map(() => v)].join(","))].join("\n") + "\n";

  it("reads rater CSVs and skips incomplete rows", () => {
    const m = readRaterCsv(csv([["a", "y"], ["b", "n"]]) + "c,y,n\n");
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")!["A1"]).toBe(true);
    expect(m.get("b")!["A1"]).toBe(false);
  });
  it("identical raters agree perfectly, opposite raters do not", () => {
    const all = readRaterCsv(csv([["a", "y"], ["b", "n"], ["c", "y"], ["d", "n"]]));
    const same = compare([...all.values()].map((a) => ({ a, b: a })));
    expect(same.overclaimKappa).toBeCloseTo(1);
    const flipped = readRaterCsv(csv([["a", "n"], ["b", "y"], ["c", "n"], ["d", "y"]]));
    const opp = compare([...all.keys()].map((id) => ({ a: all.get(id)!, b: flipped.get(id)! })));
    expect(opp.overclaimKappa).toBeLessThan(0);
  });
});
