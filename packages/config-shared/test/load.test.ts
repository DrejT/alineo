import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, loadProjectConfigWithSources } from "../src/project";
import { deepFreeze, mergeDeep } from "../src/merge";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alineo-load-"));
  roots.push(root);
  // A .git marker bounds the walk-up so a stray config outside tmp can't leak into these tests.
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

function writeProject(root: string, data: unknown): void {
  writeFileSync(join(root, "alineo.config.json"), JSON.stringify(data));
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("loadProjectConfig precedence", () => {
  test("schema defaults when nothing is set", () => {
    const root = makeRoot();
    const config = loadProjectConfig({ cwd: root, env: {}, globalPath: null });
    expect(config.serverUrl).toBe("http://127.0.0.1:8080");
    expect(config.useServerProxy).toBe(true);
    expect(config.defaults.resources.cpu).toBe("1000m");
    expect(config.defaults.resources.memory).toBe("1Gi");
  });

  test("project file beats the global file", () => {
    const root = makeRoot();
    const globalPath = join(root, "global.json");
    writeFileSync(globalPath, JSON.stringify({ serverUrl: "http://global:8080", apiKey: "g" }));
    writeProject(root, { serverUrl: "http://project:8080" });

    const config = loadProjectConfig({ cwd: root, env: {}, globalPath });
    expect(config.serverUrl).toBe("http://project:8080");
    // Untouched keys still come from the lower-precedence source.
    expect(config.apiKey).toBe("g");
  });

  test("ALINEO_CONFIG_CONTENT beats the project file", () => {
    const root = makeRoot();
    writeProject(root, { serverUrl: "http://project:8080" });
    const config = loadProjectConfig({
      cwd: root,
      globalPath: null,
      env: { ALINEO_CONFIG_CONTENT: JSON.stringify({ serverUrl: "http://inline:8080" }) },
    });
    expect(config.serverUrl).toBe("http://inline:8080");
  });

  test("env vars beat inline content, and overrides beat env", () => {
    const root = makeRoot();
    const env = {
      ALINEO_CONFIG_CONTENT: JSON.stringify({ serverUrl: "http://inline:8080", apiKey: "inline" }),
      ALINEO_SERVER_URL: "http://env:8080",
    };
    expect(loadProjectConfig({ cwd: root, globalPath: null, env }).serverUrl).toBe(
      "http://env:8080",
    );

    const withOverride = loadProjectConfig({
      cwd: root,
      globalPath: null,
      env,
      overrides: { serverUrl: "http://explicit:8080" },
    });
    expect(withOverride.serverUrl).toBe("http://explicit:8080");
    expect(withOverride.apiKey).toBe("inline");
  });

  test("nested objects merge key by key instead of replacing wholesale", () => {
    const root = makeRoot();
    writeProject(root, { defaults: { resources: { cpu: "250m" } } });
    const config = loadProjectConfig({ cwd: root, env: {}, globalPath: null });
    expect(config.defaults.resources.cpu).toBe("250m");
    expect(config.defaults.resources.memory).toBe("1Gi");
  });

  test("null means unset, so a hand-edited file degrades to defaults", () => {
    const root = makeRoot();
    // The shape an interrupted write or a hand-edit leaves behind; the old `??` reader
    // tolerated it, so validation must too rather than taking the CLI down.
    writeProject(root, { defaults: { resources: null }, apiKey: null });
    const config = loadProjectConfig({ cwd: root, env: {}, globalPath: null });
    expect(config.defaults.resources.cpu).toBe("1000m");
    expect(config.apiKey).toBe("");
  });

  test("ALINEO_USE_SERVER_PROXY parses booleans and rejects nonsense", () => {
    const root = makeRoot();
    const read = (value: string) =>
      loadProjectConfig({
        cwd: root,
        globalPath: null,
        env: { ALINEO_USE_SERVER_PROXY: value },
      }).useServerProxy;

    expect(read("false")).toBe(false);
    expect(read("0")).toBe(false);
    expect(read("true")).toBe(true);
    expect(() => read("maybe")).toThrow(/ALINEO_USE_SERVER_PROXY/);
  });

  test("discover: false ignores files and env entirely", () => {
    const root = makeRoot();
    writeProject(root, { serverUrl: "http://project:8080" });
    const config = loadProjectConfig({
      cwd: root,
      discover: false,
      env: { ALINEO_SERVER_URL: "http://env:8080" },
      overrides: { serverUrl: "http://explicit:8080" },
    });
    expect(config.serverUrl).toBe("http://explicit:8080");
  });

  test("reports which sources contributed", () => {
    const root = makeRoot();
    writeProject(root, { apiKey: "k" });
    const { sources } = loadProjectConfigWithSources({
      cwd: root,
      globalPath: null,
      env: { ALINEO_SERVER_URL: "http://env:8080" },
    });
    expect(sources.projectFile).toBe(join(root, "alineo.config.json"));
    expect(sources.envVars).toBe(true);
    expect(sources.inlineEnv).toBe(false);
  });
});

describe("loadProjectConfig failures", () => {
  test("a bad value names the key and the file", () => {
    const root = makeRoot();
    writeProject(root, { useServerProxy: "yes-please" });
    expect(() => loadProjectConfig({ cwd: root, env: {}, globalPath: null })).toThrow(
      /useServerProxy/,
    );
    expect(() => loadProjectConfig({ cwd: root, env: {}, globalPath: null })).toThrow(
      /alineo\.config\.json/,
    );
  });

  test("malformed JSON is loud, not silently replaced by defaults", () => {
    const root = makeRoot();
    writeFileSync(join(root, "alineo.config.json"), "{ not json");
    expect(() => loadProjectConfig({ cwd: root, env: {}, globalPath: null })).toThrow(
      /not valid JSON/,
    );
  });

  test("malformed ALINEO_CONFIG_CONTENT is loud too", () => {
    const root = makeRoot();
    expect(() =>
      loadProjectConfig({ cwd: root, globalPath: null, env: { ALINEO_CONFIG_CONTENT: "{oops" } }),
    ).toThrow(/ALINEO_CONFIG_CONTENT is not valid JSON/);
  });
});

describe("the resolved config is frozen", () => {
  test("top level and nested objects reject mutation", () => {
    const root = makeRoot();
    const config = loadProjectConfig({ cwd: root, env: {}, globalPath: null });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.defaults.resources)).toBe(true);
  });
});

describe("mergeDeep", () => {
  test("undefined never overwrites, but null does", () => {
    expect(mergeDeep({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
    expect(mergeDeep({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  test("arrays are replaced, not concatenated", () => {
    expect(mergeDeep({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
});

describe("deepFreeze", () => {
  test("handles primitives and already-frozen values", () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
    const frozen = Object.freeze({ a: 1 });
    expect(deepFreeze(frozen)).toBe(frozen);
  });
});
