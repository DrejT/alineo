/** POST/GET/DELETE /sandboxes, checkpoint/fork/credentials/egress. */
import { afterEach, describe, expect, test } from "bun:test";
import { call } from "./helpers";
import { fakeSandboxClient } from "./fakes";

afterEach(() => fakeSandboxClient.reset());

const RESOURCES = { cpu: "500m", memory: "256Mi" };

describe("POST /sandboxes", () => {
  test("creates a sandbox and it shows up in the list", async () => {
    const res = await call("POST", "/sandboxes", { name: "test-sb", resources: RESOURCES });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "test-sb", status: "running" });

    const list = await call("GET", "/sandboxes");
    expect(list.status).toBe(200);
    expect(list.body.sandboxes.map((s: { name: string }) => s.name)).toContain("test-sb");
  });

  test("400 without resources", async () => {
    const res = await call("POST", "/sandboxes", { name: "no-resources" });
    expect(res.status).toBe(400);
  });
});

describe("GET /sandboxes/:id", () => {
  test("404 for an unknown sandbox", async () => {
    expect((await call("GET", "/sandboxes/missing")).status).toBe(404);
  });

  test("returns the created sandbox's details", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const got = await call("GET", `/sandboxes/${created.body.sandboxId}`);
    expect(got.status).toBe(200);
    expect(got.body.sandboxId).toBe(created.body.sandboxId);
  });
});

describe("checkpoints", () => {
  test("create then list", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const id = created.body.sandboxId;

    const cp = await call("POST", `/sandboxes/${id}/checkpoint`, { name: "before-install" });
    expect(cp.status).toBe(201);
    expect(cp.body.snapshotId).toBeTruthy();

    const list = await call("GET", `/sandboxes/${id}/checkpoints`);
    expect(list.status).toBe(200);
    expect(list.body.checkpoints).toHaveLength(1);
  });
});

describe("POST /sandboxes/:id/fork", () => {
  test("creates an independent sandbox", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const id = created.body.sandboxId;

    const fork = await call("POST", `/sandboxes/${id}/fork`, { tag: "v1" });
    expect(fork.status).toBe(201);
    expect(fork.body.sandboxId).not.toBe(id);

    const list = await call("GET", "/sandboxes");
    const ids = list.body.sandboxes.map((s: { sandboxId: string }) => s.sandboxId);
    expect(ids).toEqual(expect.arrayContaining([id, fork.body.sandboxId]));
  });
});

describe("credentials", () => {
  test("set, list, remove", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const id = created.body.sandboxId;

    const set = await call("POST", `/sandboxes/${id}/credentials`, {
      name: "github",
      value: "tok_123",
      binding: { host: "api.github.com", injection: { type: "header", name: "Authorization" } },
    });
    expect(set.status).toBe(204);

    const list = await call("GET", `/sandboxes/${id}/credentials`);
    expect(list.body.bindings).toEqual([
      { name: "github", binding: { host: "api.github.com", injection: { type: "header", name: "Authorization" } } },
    ]);

    const removed = await call("DELETE", `/sandboxes/${id}/credentials/github`);
    expect(removed.status).toBe(204);
    expect((await call("GET", `/sandboxes/${id}/credentials`)).body.bindings).toEqual([]);
  });
});

describe("egress", () => {
  test("patch then delete rules", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const id = created.body.sandboxId;

    const patch = await call("PATCH", `/sandboxes/${id}/egress`, {
      rules: [{ action: "allow", target: "api.github.com" }],
    });
    expect(patch.status).toBe(204);

    const got = await call("GET", `/sandboxes/${id}/egress`);
    expect(got.body.policy.egress).toEqual([{ action: "allow", target: "api.github.com" }]);

    const del = await call("DELETE", `/sandboxes/${id}/egress`, { targets: ["api.github.com"] });
    expect(del.status).toBe(204);
    expect((await call("GET", `/sandboxes/${id}/egress`)).body.policy.egress).toEqual([]);
  });
});

describe("DELETE /sandboxes/:id", () => {
  test("closes the sandbox", async () => {
    const created = await call("POST", "/sandboxes", { resources: RESOURCES });
    const id = created.body.sandboxId;

    expect((await call("DELETE", `/sandboxes/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/sandboxes/missing`)).status).toBe(404);
  });
});
