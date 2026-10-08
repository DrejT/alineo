import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  serverConfigContent,
  withDockerHostIp,
  DOCKER_HOST_IP,
  serverConfigPath,
  serverConfigDir,
  serverDataDir,
  configPath,
  readConfig,
  writeConfig,
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

  it("sets [docker].host_ip so an egress sidecar's readiness probe can reach it", () => {
    const content = serverConfigContent(EIP);
    const docker = content.slice(content.indexOf("[docker]"), content.indexOf("[store]"));
    expect(docker).toContain(`host_ip = "${DOCKER_HOST_IP}"`);
  });
});

describe("withDockerHostIp", () => {
  const OLD = `[server]
eip = "http://127.0.0.1:8080"

[docker]
network_mode = "bridge"

[egress]
image = "opensandbox/egress:v1.1.7"
`;

  it("adds host_ip under [docker] and leaves the rest of the file alone", () => {
    const out = withDockerHostIp(OLD);
    expect(out).toBe(OLD.replace("[docker]\n", `[docker]\nhost_ip = "${DOCKER_HOST_IP}"\n`));
  });

  it("returns null when host_ip is already set, including a hand-picked value", () => {
    expect(
      withDockerHostIp(OLD.replace("[docker]\n", '[docker]\nhost_ip = "172.17.0.1"\n')),
    ).toBeNull();
  });

  it("returns null when there is no [docker] table to put it in", () => {
    expect(withDockerHostIp('[server]\neip = "x"\n')).toBeNull();
  });

  it("is a no-op on what serverConfigContent writes", () => {
    expect(withDockerHostIp(serverConfigContent("http://127.0.0.1:8080"))).toBeNull();
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
    tempDir = await mkdtemp(join(tmpdir(), "alineo-cli-shared-config-test-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fills defaults around a partial project-local alineo.config.json", async () => {
    await Bun.write("alineo.config.json", JSON.stringify({ agentsDir: "./my-agents" }));

    const config = await readConfig();

    expect(config.agentsDir).toBe("./my-agents");
    expect(config.serverUrl).toBe("http://127.0.0.1:8080");
    expect(config.useServerProxy).toBe(true);
    expect(config.defaults.resources).toEqual({ cpu: "1000m", memory: "1Gi" });
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
