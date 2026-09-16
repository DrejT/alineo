import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../src/config.js";

let tempDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = await mkdtemp(join(tmpdir(), "alineo-mcp-config-test-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("fills defaults around a partial project-local alineo.config.json", async () => {
    await Bun.write("alineo.config.json", JSON.stringify({ agentsDir: "./my-agents" }));

    const config = await readConfig();

    expect(config.agentsDir).toBe("./my-agents");
    expect(config.serverUrl).toBe("http://127.0.0.1:8080");
    expect(config.useServerProxy).toBe(true);
    expect(config.defaults.resources).toEqual({ cpu: "1000m", memory: "1Gi" });
  });

  it("round-trips through writeConfig", async () => {
    await writeConfig({
      serverUrl: "http://example.test:8080",
      useServerProxy: false,
      apiKey: "secret",
      adapterPath: "./.alineo/ledger.db",
      agentsDir: "./agents",
      defaults: { resources: { cpu: "2000m", memory: "2Gi" } },
    });

    const config = await readConfig();

    expect(config.serverUrl).toBe("http://example.test:8080");
    expect(config.useServerProxy).toBe(false);
    expect(config.apiKey).toBe("secret");
    expect(config.defaults.resources).toEqual({ cpu: "2000m", memory: "2Gi" });
  });
});
