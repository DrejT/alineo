import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpec, listSpecs, removeSpec } from "../src/specs.js";
import { writeConfig } from "@alineo-labs/cli-shared";
import { expectRejects } from "./assertions.js";

let tempDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = await mkdtemp(join(tmpdir(), "alineo-mcp-specs-test-"));
  process.chdir(tempDir);
  // A project-local alineo.config.json keeps readConfig() from falling through to its
  // global-fallback branch, which would otherwise read/write the real ~/.config/alineo.
  await writeConfig({
    serverUrl: "http://127.0.0.1:8080",
    useServerProxy: true,
    apiKey: "",
    adapterPath: "./.alineo/ledger.db",
    agentsDir: "./agents",
    defaults: { resources: { cpu: "1000m", memory: "1Gi" } },
  });
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

describe("listSpecs", () => {
  it("returns an empty list when no agents dir exists yet", async () => {
    expect(await listSpecs()).toEqual([]);
  });
});

describe("addSpec / listSpecs / removeSpec", () => {
  it("saves a spec from a local file and lists it back", async () => {
    const source = join(tempDir, "source-spec.json");
    await Bun.write(
      source,
      JSON.stringify({ name: "reviewer", cli: "pi", description: "Reviews code" }),
    );

    const result = await addSpec(source);
    expect(result.name).toBe("reviewer");
    expect(await Bun.file(result.path).exists()).toBe(true);

    const specs = await listSpecs();
    expect(specs).toEqual([{ name: "reviewer", cli: "pi", description: "Reviews code" }]);
  });

  it("honors an explicit name override for the saved filename", async () => {
    const source = join(tempDir, "source-spec.json");
    await Bun.write(source, JSON.stringify({ name: "reviewer", cli: "pi" }));

    const result = await addSpec(source, "my-reviewer");
    expect(result.name).toBe("my-reviewer");
    expect(result.path.endsWith("my-reviewer.json")).toBe(true);
  });

  it("recursively resolves registryDependencies", async () => {
    const dep = join(tempDir, "dep-spec.json");
    await Bun.write(dep, JSON.stringify({ name: "dep", cli: "pi" }));
    const root = join(tempDir, "root-spec.json");
    await Bun.write(root, JSON.stringify({ name: "root", cli: "pi", registryDependencies: [dep] }));

    const result = await addSpec(root);
    expect(result.resolvedDependencies).toEqual([dep]);

    const specs = (await listSpecs()).map((s) => s.name).sort();
    expect(specs).toEqual(["dep", "root"]);
  });

  it("rejects a self-referencing registryDependency instead of looping forever", async () => {
    const selfRef = join(tempDir, "self-ref-spec.json");
    await Bun.write(
      selfRef,
      JSON.stringify({ name: "self", cli: "pi", registryDependencies: [selfRef] }),
    );

    const err = await expectRejects(addSpec(selfRef));
    expect((err as Error).message).toContain("Circular registryDependencies");
  });

  it("rejects a circular chain of registryDependencies (A -> B -> A)", async () => {
    const specA = join(tempDir, "a-spec.json");
    const specB = join(tempDir, "b-spec.json");
    await Bun.write(specA, JSON.stringify({ name: "a", cli: "pi", registryDependencies: [specB] }));
    await Bun.write(specB, JSON.stringify({ name: "b", cli: "pi", registryDependencies: [specA] }));

    const err = await expectRejects(addSpec(specA));
    expect((err as Error).message).toContain("Circular registryDependencies");
  });

  it("rejects a spec missing required fields", async () => {
    const source = join(tempDir, "bad-spec.json");
    await Bun.write(source, JSON.stringify({ title: "no name or cli" }));

    await expectRejects(addSpec(source));
  });

  it("removes a saved spec", async () => {
    const source = join(tempDir, "source-spec.json");
    await Bun.write(source, JSON.stringify({ name: "reviewer", cli: "pi" }));
    await addSpec(source);

    await removeSpec("reviewer");

    expect(await listSpecs()).toEqual([]);
  });

  it("throws a clear error removing a spec that doesn't exist", async () => {
    const err = await expectRejects(removeSpec("nonexistent"));
    expect((err as Error).message).toContain("No agent spec named");
  });
});
