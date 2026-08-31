/**
 * Integration test for the human-in-the-loop permission gate.
 *
 * Requires OpenSandbox running (alineo init or uvx opensandbox-server) and GEMINI_API_KEY
 * (free tier — https://aistudio.google.com/apikey).
 *
 * Run: GEMINI_API_KEY=... bun test tests/integration/human-in-the-loop.test.ts --timeout 600000
 */
import { Alineo, type AgentEvent } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { afterAll, expect, test } from "bun:test";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required to run this test");
}

const BASE = {
  $schema: "https://registry.alineo.tech/spec/agent.json",
  cli: "pi" as const,
  packages: [],
  model: "gemini-flash-latest",
  env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

const agents: Alineo[] = [];
afterAll(async () => {
  for (const a of agents) await a.close();
});

async function load(spec: Record<string, unknown>): Promise<Alineo> {
  const a = await Alineo.load(spec, { adapter: new SQLiteAdapter(":memory:") });
  agents.push(a);
  return a;
}

test(
  "gated tool call emits permission_request and a reject blocks it",
  async () => {
    const agent = await load({
      ...BASE,
      name: "hitl-ask",
      permissions: { default: "ask", rules: [{ tool: "read", action: "allow" }] },
    });

    const seen: AgentEvent["type"][] = [];
    let denied = false;
    for await (const ev of agent.prompt(
      "Run this exact shell command and nothing else: echo permission-test > /tmp/hitl.txt",
    )) {
      seen.push(ev.type);
      if (ev.type === "permission_request") {
        expect(ev.tool).toBe("bash");
        expect(ev.requestId).toBeTruthy();
        await agent.resolvePermission(ev.requestId, {
          kind: "reject",
          feedback: "Do not write that file.",
        });
        denied = true;
      }
    }

    expect(seen).toContain("permission_request");
    expect(seen).toContain("permission_resolved");
    expect(denied).toBe(true);

    // The reject actually blocked the write.
    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl.txt 2>/dev/null || echo MISSING");
    expect(stdout.trim()).toBe("MISSING");
  },
  600_000,
);

test(
  "allow-once lets the call through",
  async () => {
    const agent = await load({ ...BASE, name: "hitl-allow", permissions: "ask" });

    for await (const ev of agent.prompt(
      "Run this exact shell command and nothing else: echo approved > /tmp/hitl-ok.txt",
    )) {
      if (ev.type === "permission_request") {
        await agent.resolvePermission(ev.requestId, { kind: "once" });
      }
    }

    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl-ok.txt");
    expect(stdout.trim()).toBe("approved");
  },
  600_000,
);

test(
  "no permissions field → never emits permission_request (back-compat)",
  async () => {
    const agent = await load({ ...BASE, name: "hitl-auto" });

    const seen: AgentEvent["type"][] = [];
    for await (const ev of agent.prompt(
      "Run this exact shell command and nothing else: echo auto > /tmp/hitl-auto.txt",
    )) {
      seen.push(ev.type);
    }

    expect(seen).not.toContain("permission_request");
    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl-auto.txt");
    expect(stdout.trim()).toBe("auto");
  },
  600_000,
);
