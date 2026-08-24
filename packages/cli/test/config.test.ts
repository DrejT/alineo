import { describe, it, expect } from "bun:test";
import { join } from "path";
import {
  serverConfigContent,
  serverConfigPath,
  serverConfigDir,
  serverDataDir,
  configPath,
} from "../src/config.js";

describe("serverConfigContent", () => {
  it("contains [server]", () => {
    expect(serverConfigContent()).toContain("[server]");
  });

  it("contains [runtime]", () => {
    expect(serverConfigContent()).toContain("[runtime]");
  });

  it("contains [docker]", () => {
    expect(serverConfigContent()).toContain("[docker]");
  });

  it("contains [store]", () => {
    expect(serverConfigContent()).toContain("[store]");
  });

  it('contains eip = "http://127.0.0.1:8080"', () => {
    expect(serverConfigContent()).toContain(`eip = "http://127.0.0.1:8080"`);
  });

  it('contains type = "docker"', () => {
    expect(serverConfigContent()).toContain(`type = "docker"`);
  });

  it('contains network_mode = "bridge"', () => {
    expect(serverConfigContent()).toContain(`network_mode = "bridge"`);
  });

  it("contains port = 8080", () => {
    expect(serverConfigContent()).toContain("port = 8080");
  });

  it("pins [store].path to the container-side mount target set up in init.ts (/data)", () => {
    expect(serverConfigContent()).toContain(`path = "/data/opensandbox.db"`);
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
