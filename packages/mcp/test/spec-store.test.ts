import { describe, expect, it } from "bun:test";
import {
  addRemoteSpec,
  MAX_REGISTRY_DEPENDENCIES,
  MAX_STORED_SPECS,
  MemorySpecStore,
  SPEC_NAME,
} from "../src/spec-store.js";
import { stubFetch } from "./fetch-stub.js";
import { expectRejects } from "./assertions.js";

const spec = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  harness: "pi",
  model: "some-model",
  ...extra,
});
const publicDns = async () => ["93.184.216.34"];
const serving = (files: Record<string, unknown>) =>
  stubFetch(async (url) => {
    const body = files[String(url)];
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(body));
  });

describe("SPEC_NAME", () => {
  it("accepts ordinary names", () => {
    for (const n of ["researcher", "a", "my-agent_2.v1", "A1"])
      expect(SPEC_NAME.test(n), n).toBe(true);
  });
  it("refuses anything that could leave a directory or hide", () => {
    for (const n of [
      "",
      ".hidden",
      "../x",
      "a/b",
      "a\\b",
      "a b",
      "x".repeat(65),
      "-lead",
      "a\u0000b",
    ]) {
      expect(SPEC_NAME.test(n), JSON.stringify(n)).toBe(false);
    }
  });
});

describe("MemorySpecStore", () => {
  it("puts, gets, lists and removes", async () => {
    const store = new MemorySpecStore();
    await store.put("a", spec("a") as never);
    expect((await store.get("a"))?.name).toBe("a");
    expect(await store.list()).toEqual([{ name: "a", harness: "pi", description: "" }]);
    expect(await store.remove("a")).toBe(true);
    expect(await store.remove("a")).toBe(false);
    expect(await store.get("a")).toBeUndefined();
  });

  it("refuses a new spec past the cap, but still replaces an existing one", async () => {
    const store = new MemorySpecStore();
    for (let i = 0; i < MAX_STORED_SPECS; i++) await store.put(`s${i}`, spec(`s${i}`) as never);
    await expectRejects(store.put("one-too-many", spec("x") as never));
    await store.put("s0", spec("s0", { description: "new" }) as never);
    expect((await store.get("s0"))?.description).toBe("new");
  });
});

describe("addRemoteSpec", () => {
  it("stores an inline spec under its own name", async () => {
    const store = new MemorySpecStore();
    const out = await addRemoteSpec(store, { spec: spec("writer") });
    expect(out.name).toBe("writer");
    expect((await store.get("writer"))?.model).toBe("some-model");
  });

  it("stores it under a given name instead", async () => {
    const store = new MemorySpecStore();
    await addRemoteSpec(store, { spec: spec("writer"), name: "draft" });
    expect(await store.get("draft")).toBeDefined();
    expect(await store.get("writer")).toBeUndefined();
  });

  it("needs exactly one of spec and url", async () => {
    const store = new MemorySpecStore();
    await expectRejects(addRemoteSpec(store, {}));
    await expectRejects(
      addRemoteSpec(store, { spec: spec("a"), url: "https://example.com/a.json" }),
    );
  });

  it("rejects an invalid spec and a bad name, and stores nothing", async () => {
    const store = new MemorySpecStore();
    await expectRejects(addRemoteSpec(store, { spec: { name: "no-model" } }));
    await expectRejects(addRemoteSpec(store, { spec: spec("ok"), name: "../escape" }));
    await expectRejects(addRemoteSpec(store, { spec: spec("../escape") }));
    expect(await store.list()).toEqual([]);
  });

  it("fetches by public URL", async () => {
    const store = new MemorySpecStore();
    const fetchImpl = serving({ "https://example.com/a.json": spec("fetched") });
    const out = await addRemoteSpec(
      store,
      { url: "https://example.com/a.json" },
      { resolve: publicDns, fetchImpl },
    );
    expect(out.name).toBe("fetched");
  });

  it("refuses a local path or a private URL and never fetches", async () => {
    const store = new MemorySpecStore();
    const fetchImpl = stubFetch(async () => new Response("{}"));
    for (const url of [
      "/etc/passwd",
      "file:///etc/passwd",
      "../../.ssh/id_rsa",
      "https://127.0.0.1:8080/v1/sandboxes",
    ]) {
      await expectRejects(addRemoteSpec(store, { url }, { resolve: publicDns, fetchImpl }));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches registryDependencies the same way, and stores them", async () => {
    const store = new MemorySpecStore();
    const fetchImpl = serving({
      "https://example.com/root.json": spec("root", {
        registryDependencies: ["https://example.com/dep.json"],
      }),
      "https://example.com/dep.json": spec("dep"),
    });
    const out = await addRemoteSpec(
      store,
      { url: "https://example.com/root.json" },
      { resolve: publicDns, fetchImpl },
    );
    expect(out.resolvedDependencies).toEqual(["https://example.com/dep.json"]);
    expect(await store.get("dep")).toBeDefined();
    expect(await store.get("root")).toBeDefined();
  });

  it("refuses a dependency that points at a private address", async () => {
    const store = new MemorySpecStore();
    const fetchImpl = serving({
      "https://example.com/root.json": spec("root", {
        registryDependencies: ["https://10.0.0.1/x.json"],
      }),
    });
    await expectRejects(
      addRemoteSpec(
        store,
        { url: "https://example.com/root.json" },
        { resolve: publicDns, fetchImpl },
      ),
    );
    expect(await store.get("root")).toBeUndefined();
  });

  it("detects a dependency cycle", async () => {
    const store = new MemorySpecStore();
    const fetchImpl = serving({
      "https://example.com/a.json": spec("a", {
        registryDependencies: ["https://example.com/b.json"],
      }),
      "https://example.com/b.json": spec("b", {
        registryDependencies: ["https://example.com/a.json"],
      }),
    });
    const err = await expectRejects(
      addRemoteSpec(
        store,
        { url: "https://example.com/a.json" },
        { resolve: publicDns, fetchImpl },
      ),
    );
    expect((err as Error).message).toContain("Circular");
  });

  it("stops following dependencies past the cap", async () => {
    const store = new MemorySpecStore();
    const deps = Array.from(
      { length: MAX_REGISTRY_DEPENDENCIES + 1 },
      (_, i) => `https://example.com/d${i}.json`,
    );
    const files: Record<string, unknown> = {
      "https://example.com/root.json": spec("root", { registryDependencies: deps }),
    };
    deps.forEach((d, i) => (files[d] = spec(`d${i}`)));
    const err = await expectRejects(
      addRemoteSpec(
        store,
        { url: "https://example.com/root.json" },
        { resolve: publicDns, fetchImpl: serving(files) },
      ),
    );
    expect((err as Error).message).toContain("registryDependencies");
  });
});
