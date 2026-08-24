import { describe, it, expect } from "bun:test";
import type { SandboxHandle } from "@alineo-labs/core";
import { PiAdapter } from "../src/adapters/pi";
import type { AgentSpec } from "../src/schema";

function fakeSandbox() {
  const commands: string[] = [];
  const sb = {
    exec: (cmd: string) => {
      commands.push(cmd);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    },
    proxy: (_port: number) => Promise.resolve({ url: "http://fake-proxy", headers: {} }),
  } as unknown as SandboxHandle;
  return { sb, commands };
}

function baseSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { name: "test-agent", cli: "pi", ...overrides };
}

describe("PiAdapter.install", () => {
  it("installs the bare package when cliVersion is omitted", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().install(sb, baseSpec());
    expect(commands).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
  });

  it("pins an exact version", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().install(sb, baseSpec({ cliVersion: "1.2.3" }));
    expect(commands).toContain(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.3",
    );
  });

  it("passes through a semver range", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().install(sb, baseSpec({ cliVersion: "^1.2.0" }));
    expect(commands).toContain(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@^1.2.0",
    );
  });

  it("passes through a dist-tag", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().install(sb, baseSpec({ cliVersion: "latest" }));
    expect(commands).toContain(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest",
    );
  });
});

describe("PiAdapter.startBridge", () => {
  it("starts the bridge with no prefix when unsetVars is omitted", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().startBridge(sb);
    expect(commands).toContain("node /alineo-bridge.js &");
  });

  it("starts the bridge with no prefix when unsetVars is empty", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().startBridge(sb, []);
    expect(commands).toContain("node /alineo-bridge.js &");
  });

  it("prefixes an explicit unset of every named var in the same command", async () => {
    const { sb, commands } = fakeSandbox();
    await new PiAdapter().startBridge(sb, ["GEMINI_API_KEY", "SECRET_TEST_VALUE"]);
    expect(commands).toContain("unset GEMINI_API_KEY SECRET_TEST_VALUE; node /alineo-bridge.js &");
  });
});
