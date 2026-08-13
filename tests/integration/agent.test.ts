/**
 * Integration tests for @alineo-labs/agent.
 *
 * Requires OpenSandbox running (alineo init or uvx opensandbox-server).
 * Uses Google Gemini (gemini-flash-latest = gemini-3.5-flash) — free tier, works with GEMINI_API_KEY.
 *
 * Run with: bun test tests/integration/agent.test.ts --timeout 600000
 */
import { Agent } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { beforeAll, afterAll, test, expect, describe } from "bun:test";

const GEMINI_API_KEY = "AIzaSyBNyRoeeX_gsuL1Dqj9ElcjBGtw1cAdKhc";

const SPEC = {
  $schema: "https://registry.alineo.tech/spec/agent.json",
  name: "test-agent",
  cli: "pi" as const,
  packages: [],
  model: "gemini-flash-latest",
  env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

let agent: Agent;

beforeAll(async () => {
  // Expose the key so the spec's ${GEMINI_API_KEY} interpolation resolves it.
  process.env.GEMINI_API_KEY = GEMINI_API_KEY;

  const specPath = "/tmp/test-agent-spec.json";
  await Bun.write(specPath, JSON.stringify(SPEC));
  agent = await Agent.load(specPath, { adapter: new SQLiteAdapter("./.alineo/ledger.db") });
}, 600_000);

afterAll(async () => {
  await agent?.close();
});

describe("agent.sandbox (direct container access — no Pi involved)", () => {
  test("exec returns stdout", async () => {
    const { stdout } = await agent.sandbox.exec('echo "alineo-works"');
    expect(stdout.trim()).toBe("alineo-works");
  }, 30_000);

  test("writeFile and readFile round-trip", async () => {
    await agent.sandbox.writeFile("/tmp/test.txt", "hello agent\n");
    const content = await agent.sandbox.readFile("/tmp/test.txt");
    expect(content.trim()).toBe("hello agent");
  }, 30_000);

  test("exec sees files written by writeFile", async () => {
    await agent.sandbox.writeFile("/tmp/wc-test.txt", "one two three four five");
    const { stdout } = await agent.sandbox.exec("wc -w /tmp/wc-test.txt");
    expect(stdout.trim()).toMatch(/^5/);
  }, 30_000);

  test("exec can run installed nix packages", async () => {
    const { stdout } = await agent.sandbox.exec("node --version");
    expect(stdout.trim()).toMatch(/^v\d+/);
  }, 30_000);
});

describe("agent.setEnv", () => {
  test("env var is written to /etc/alineo-env", async () => {
    await agent.setEnv({ ALINEO_TEST_VAR: "integration-test-value" });
    const { stdout } = await agent.sandbox.exec(". /etc/alineo-env && echo $ALINEO_TEST_VAR");
    expect(stdout.trim()).toBe("integration-test-value");
  }, 30_000);
});

describe("agent.prompt (Pi RPC — Google Gemini)", () => {
  test("streams a response to a simple prompt", async () => {
    const chunks: string[] = [];
    for await (const chunk of agent.prompt("Reply with exactly: pong")) {
      chunks.push(chunk);
    }
    expect(chunks.join("").toLowerCase()).toContain("pong");
  }, 60_000);

  test("maintains session context across prompts", async () => {
    for await (const _ of agent.prompt("Remember the word: ZEPHYR. Confirm you have it.")) {
      // consume
    }

    const chunks: string[] = [];
    for await (const c of agent.prompt("What was the word I asked you to remember?")) {
      chunks.push(c);
    }
    expect(chunks.join("").toUpperCase()).toContain("ZEPHYR");
  }, 120_000);

  test("newSession clears context", async () => {
    for await (const _ of agent.prompt("Remember the codeword: BANANA. Confirm.")) {
      // consume
    }

    await agent.newSession();

    const chunks: string[] = [];
    for await (const c of agent.prompt("What codeword did I give you?")) {
      chunks.push(c);
    }
    expect(chunks.join("").toUpperCase()).not.toContain("BANANA");
  }, 120_000);
});
