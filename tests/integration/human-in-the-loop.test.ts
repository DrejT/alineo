/**
 * Integration test for the human-in-the-loop permission gate.
 *
 * Requires OpenSandbox running (`bunx alineo-cli init` or `uvx opensandbox-server`) and
 * NVIDIA_API_KEY (https://build.nvidia.com). Model: nvidia/nemotron-3-nano-30b-a3b —
 * fast, reliable tool calls, and it adjusts after a deny-with-feedback.
 *
 * Run: NVIDIA_API_KEY=... bun test tests/integration/human-in-the-loop.test.ts --timeout 600000
 */
import { Alineo, type AgentEvent, type PermissionRequest } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { afterAll, expect, test } from "bun:test";

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
if (!NVIDIA_API_KEY) {
  throw new Error("NVIDIA_API_KEY env var is required to run this test");
}

const BASE = {
  $schema: "https://registry.alineo.tech/spec/agent.json",
  cli: "pi" as const,
  packages: ["python3"],
  provider: "nvidia",
  model: "nvidia/nemotron-3-nano-30b-a3b",
  env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

const agents: Alineo[] = [];
afterAll(async () => {
  for (const a of agents) await a.close();
});

async function load(spec: Record<string, unknown>): Promise<{ agent: Alineo; adapter: SQLiteAdapter }> {
  const adapter = new SQLiteAdapter(":memory:");
  const agent = await Alineo.load(spec, { adapter });
  agents.push(agent);
  return { agent, adapter };
}

const runExact = (cmd: string) => `Run this exact shell command and nothing else: ${cmd}`;

test(
  "gated tool call emits permission_request; reject with feedback blocks the write",
  async () => {
    const { agent } = await load({
      ...BASE,
      name: "hitl-ask",
      permissions: { default: "ask", rules: [{ tool: "read", action: "allow" }] },
    });

    const seen: AgentEvent["type"][] = [];
    for await (const ev of agent.prompt(runExact("echo permission-test > /tmp/hitl.txt"))) {
      seen.push(ev.type);
      if (ev.type === "permission_request") {
        expect(ev.tool).toBe("bash");
        expect(ev.requestId).toBeTruthy();
        await agent.resolvePermission(ev.requestId, {
          kind: "reject",
          feedback: "Do not write that file.",
        });
      }
    }

    expect(seen).toContain("permission_request");
    expect(seen).toContain("permission_resolved");

    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl.txt 2>/dev/null || echo MISSING");
    expect(stdout.trim()).toBe("MISSING");
  },
  600_000,
);

test(
  "allow-once lets the call through",
  async () => {
    const { agent } = await load({ ...BASE, name: "hitl-allow", permissions: "ask" });

    for await (const ev of agent.prompt(runExact("echo approved > /tmp/hitl-ok.txt"))) {
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
  "classify: a read-only bash command runs without a prompt",
  async () => {
    const { agent } = await load({
      ...BASE,
      name: "hitl-classify",
      permissions: { default: "ask", rules: [{ tool: "bash", action: "classify" }] },
    });

    const seen: AgentEvent["type"][] = [];
    for await (const ev of agent.prompt(runExact("cat /etc/os-release"))) {
      seen.push(ev.type);
      if (ev.type === "permission_request") {
        await agent.resolvePermission(ev.requestId, { kind: "reject" });
      }
    }
    expect(seen).not.toContain("permission_request");
  },
  600_000,
);

test(
  "onPermission handler auto-resolves, and the ledger records every decision",
  async () => {
    const { agent, adapter } = await load({ ...BASE, name: "hitl-onperm", permissions: "ask" });

    const requests: PermissionRequest[] = [];
    for await (const _ of agent.prompt(runExact("echo via-handler > /tmp/hitl-h.txt"), {
      onPermission: (req) => {
        requests.push(req);
        return { kind: "once" };
      },
    })) {
      void _;
    }

    expect(requests.length).toBeGreaterThan(0);
    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl-h.txt");
    expect(stdout.trim()).toBe("via-handler");
    expect(await agent.listPendingPermissions()).toHaveLength(0);

    const events = await adapter.readAll(agent.name, agent.sandboxId);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("permission_requested");
    expect(kinds).toContain("permission_resolved");
  },
  600_000,
);

test(
  'permissions: "readonly" removes write/bash from the toolset',
  async () => {
    const { agent } = await load({ ...BASE, name: "hitl-readonly", permissions: "readonly" });

    const seen: AgentEvent["type"][] = [];
    for await (const ev of agent.prompt(
      "Create a file /tmp/ro.txt containing the word hello. If you cannot, say CANNOT.",
    )) {
      seen.push(ev.type);
      if (ev.type === "permission_request") {
        await agent.resolvePermission(ev.requestId, { kind: "reject" });
      }
    }

    const { stdout } = await agent.sandbox.exec("cat /tmp/ro.txt 2>/dev/null || echo MISSING");
    expect(stdout.trim()).toBe("MISSING");
    expect(seen).not.toContain("permission_request");
  },
  600_000,
);

test(
  "no permissions field → never emits permission_request (back-compat)",
  async () => {
    const { agent } = await load({ ...BASE, name: "hitl-auto" });

    const seen: AgentEvent["type"][] = [];
    for await (const ev of agent.prompt(runExact("echo auto > /tmp/hitl-auto.txt"))) {
      seen.push(ev.type);
    }

    expect(seen).not.toContain("permission_request");
    const { stdout } = await agent.sandbox.exec("cat /tmp/hitl-auto.txt");
    expect(stdout.trim()).toBe("auto");
  },
  600_000,
);
