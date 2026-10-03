/** POST /workflows, GET /workflows(/:id), POST /workflows/:id/retry. */
import { afterEach, describe, expect, test } from "bun:test";
import { call, until } from "./helpers";
import { fakeSandboxClient } from "./fakes";

afterEach(() => fakeSandboxClient.reset());

describe("POST /workflows", () => {
  test("runs each step in order and records its output", async () => {
    const res = await call("POST", "/workflows", {
      name: "ci",
      steps: [
        { name: "install", run: "npm ci" },
        { name: "test", run: "npm test" },
      ],
    });
    expect(res.status).toBe(202);
    const id = res.body.id;

    const done = await until(async () => {
      const r = await call("GET", `/workflows/${id}`);
      return r.body.run.status !== "running" ? r.body : null;
    });
    expect(done.run.status).toBe("done");
    expect(done.steps).toHaveLength(2);
    expect(done.steps.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["install", "done"],
      ["test", "done"],
    ]);
    expect(done.steps[0].stdout).toContain("npm ci");
  });

  test("400 with no steps", async () => {
    expect((await call("POST", "/workflows", { name: "empty", steps: [] })).status).toBe(400);
  });
});

describe("GET /workflows", () => {
  test("lists runs newest first", async () => {
    const a = await call("POST", "/workflows", { name: "a", steps: [{ name: "s", run: "echo a" }] });
    const b = await call("POST", "/workflows", { name: "b", steps: [{ name: "s", run: "echo b" }] });
    await until(async () => (await call("GET", `/workflows/${b.body.id}`)).body.run.status !== "running");

    const list = await call("GET", "/workflows");
    const ids = list.body.runs.map((r: { id: string }) => r.id);
    expect(ids.indexOf(b.body.id)).toBeLessThan(ids.indexOf(a.body.id));
  });
});

describe("POST /workflows/:id/retry", () => {
  test("starts a new run with the same steps", async () => {
    const first = await call("POST", "/workflows", {
      name: "flaky",
      steps: [{ name: "s", run: "echo hi" }],
    });
    await until(async () => (await call("GET", `/workflows/${first.body.id}`)).body.run.status !== "running");

    const retry = await call("POST", `/workflows/${first.body.id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.id).not.toBe(first.body.id);

    const retried = await until(async () => {
      const r = await call("GET", `/workflows/${retry.body.id}`);
      return r.body.run.status !== "running" ? r.body : null;
    });
    expect(retried.run.name).toBe("flaky");
    expect(retried.steps.map((s: { run: string }) => s.run)).toEqual(["echo hi"]);
  });

  test("404 for an unknown run", async () => {
    expect((await call("POST", "/workflows/missing/retry")).status).toBe(404);
  });
});
