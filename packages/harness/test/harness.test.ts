import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../src/index";

const tmpDirs: string[] = [];
async function tmpPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("section accumulation", () => {
  test("chained calls append fragments to the same section, in order", () => {
    const h = harness().context("first fact").context("second fact");
    expect(h.render()).toBe("<context>\nfirst fact\n\nsecond fact\n</context>");
  });

  test("section() and the matching sugar method write to the same section", () => {
    const h = harness();
    h.section("guardrail", "via section()");
    h.guardrail("via sugar method");
    expect(h.render()).toBe("<guardrail>\nvia section()\n\nvia sugar method\n</guardrail>");
  });

  test("custom section names work identically to built-ins", () => {
    const h = harness().section("custom-thing", "hello");
    expect(h.render()).toBe("<custom-thing>\nhello\n</custom-thing>");
  });
});

describe("render()", () => {
  test("wraps each section in a matching XML tag", () => {
    const h = harness().role("be helpful").context("it is 2026");
    expect(h.render()).toBe("<role>\nbe helpful\n</role>\n\n<context>\nit is 2026\n</context>");
  });

  test("built-in sections render in canonical order regardless of call order", () => {
    const h = harness().examples("ex").guardrail("no leaks").role("assistant");
    const order = ["role", "guardrail", "examples"];
    const rendered = h.render();
    const positions = order.map((name) => rendered.indexOf(`<${name}>`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("a section nobody wrote to is omitted entirely", () => {
    const h = harness().role("only this");
    expect(h.render()).not.toContain("guardrail");
    expect(h.render()).not.toContain("context");
  });

  test("an untouched harness renders as an empty string", () => {
    expect(harness().render()).toBe("");
  });
});

describe("log()", () => {
  test("logs the section structure (markdown headers), not the rendered XML tags", () => {
    const h = harness().role("be helpful");
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      h.log();
    } finally {
      console.log = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("## role\n\nbe helpful");
    expect(calls[0]?.[0]).not.toContain("<role>");
  });
});

describe("dumps() / load() round trip", () => {
  test("load() after dumps() produces an equivalent render()", async () => {
    const path = await tmpPath("harness.md");
    const original = harness()
      .role("be helpful")
      .context("fact one")
      .context("fact two")
      .guardrail("no leaks");
    await original.dumps(path);

    const reloaded = await harness().load(path);
    expect(reloaded.render()).toBe(original.render());
  });

  test("dumps() omits sections with no content", async () => {
    const path = await tmpPath("harness.md");
    await harness().role("only this").dumps(path);
    const content = await Bun.file(path).text();
    expect(content).not.toContain("## guardrail");
    expect(content).toContain("## role");
  });

  test("load() replaces existing content rather than merging", async () => {
    const firstPath = await tmpPath("first.md");
    const secondPath = await tmpPath("second.md");
    await harness().role("first role").context("first context").dumps(firstPath);
    await harness().guardrail("second guardrail").dumps(secondPath);

    const h = await harness().load(firstPath);
    await h.load(secondPath);

    expect(h.render()).toBe("<guardrail>\nsecond guardrail\n</guardrail>");
  });

  test("load() returns the same instance it was called on", async () => {
    const path = await tmpPath("harness.md");
    await harness().role("x").dumps(path);
    const h = harness();
    const result = await h.load(path);
    expect(result).toBe(h);
  });
});
