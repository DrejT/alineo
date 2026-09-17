import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  serverConfigContent,
  serverConfigPath,
  serverConfigDir,
  serverDataDir,
  configPath,
  readConfig,
} from "../src/config.js";

describe("serverConfigContent", () => {
  const EIP = "http://127.0.0.1:8080";

  it("contains [server]", () => {
    expect(serverConfigContent(EIP)).toContain("[server]");
  });

  it("contains [runtime]", () => {
    expect(serverConfigContent(EIP)).toContain("[runtime]");
  });

  it("contains [docker]", () => {
    expect(serverConfigContent(EIP)).toContain("[docker]");
  });

  it("contains [store]", () => {
    expect(serverConfigContent(EIP)).toContain("[store]");
  });

  it("embeds the eip it's given", () => {
    expect(serverConfigContent(EIP)).toContain(`eip = "${EIP}"`);
    expect(serverConfigContent("http://host.docker.internal:8080")).toContain(
      `eip = "http://host.docker.internal:8080"`,
    );
  });

  it('contains type = "docker"', () => {
    expect(serverConfigContent(EIP)).toContain(`type = "docker"`);
  });

  it('contains network_mode = "bridge"', () => {
    expect(serverConfigContent(EIP)).toContain(`network_mode = "bridge"`);
  });

  it("contains port = 8080", () => {
    expect(serverConfigContent(EIP)).toContain("port = 8080");
  });

  it("pins [store].path to the container-side mount target set up in init.ts (/data)", () => {
    expect(serverConfigContent(EIP)).toContain(`path = "/data/opensandbox.db"`);
  });
});

describe("serverConfigPath", () => {
  it("ends with server.toml", () => {
    expect(serverConfigPath()).toMatch(/server\.toml$/);
  });
});

describe("serverDataDir", () => {
  it("lives under serverConfigDir(), not inside a project or the container", () => {
    expect(serverDataDir()).toBe(join(serverConfigDir(), "opensandbox-data"));
  });
});

describe("configPath", () => {
  it("equals alineo.config.json", () => {
    expect(configPath()).toBe("alineo.config.json");
  });
});

describe("readConfig", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "alineo-cli-config-test-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fills resource defaults when `defaults` is present but empty", async () => {
    await Bun.write("alineo.config.json", JSON.stringify({ defaults: {} }));

    const config = await readConfig();

    expect(config.defaults.resources).toEqual({ cpu: "1000m", memory: "1Gi" });
  });

  it("fills resource defaults when `defaults.resources` is null", async () => {
    await Bun.write("alineo.config.json", JSON.stringify({ defaults: { resources: null } }));

    const config = await readConfig();

    expect(config.defaults.resources).toEqual({ cpu: "1000m", memory: "1Gi" });
  });
});
