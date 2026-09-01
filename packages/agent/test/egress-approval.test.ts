import { describe, expect, it } from "bun:test";
import type { SandboxHandle } from "@alineo-labs/core";
import { EgressApprovalGate, type EgressDecision } from "../src/agent/egress-approval";

interface FakeSandbox {
  handle: SandboxHandle;
  patches: Array<Array<{ action: string; target: string }>>;
  emits: Array<{ event: string; payload: unknown }>;
}

function fakeSandbox(): FakeSandbox {
  const patches: FakeSandbox["patches"] = [];
  const emits: FakeSandbox["emits"] = [];
  const handle = {
    egress: {
      patch: async (rules: Array<{ action: string; target: string }>) => {
        patches.push(rules);
      },
    },
    emit: async (event: string, _step: number, payload: unknown) => {
      emits.push({ event, payload });
    },
  } as unknown as SandboxHandle;
  return { handle, patches, emits };
}

/** POST a synthetic deny-webhook body to the gate's listener and let it settle. */
async function fireWebhook(gate: EgressApprovalGate, hostname: string) {
  await fetch(gate.webhookUrl.replace("172.17.0.1", "127.0.0.1"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname }),
  });
  await new Promise((r) => setTimeout(r, 50));
}

describe("EgressApprovalGate", () => {
  it("calls the handler for a held host and patches allow on approval", async () => {
    const sb = fakeSandbox();
    const seen: string[] = [];
    const gate = new EgressApprovalGate({
      heldHosts: ["api.example.com"],
      handler: (req): EgressDecision => {
        seen.push(req.host);
        return "allow-always";
      },
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "api.example.com");
      expect(seen).toEqual(["api.example.com"]);
      expect(sb.patches).toEqual([[{ action: "allow", target: "api.example.com" }]]);
      expect(sb.emits.map((e) => e.event)).toEqual(["permission_requested", "permission_resolved"]);
    } finally {
      await gate.stop();
    }
  });

  it("ignores a host it is not holding", async () => {
    const sb = fakeSandbox();
    let called = false;
    const gate = new EgressApprovalGate({
      heldHosts: ["held.example.com"],
      handler: () => {
        called = true;
        return "allow-once";
      },
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "other.example.com");
      expect(called).toBe(false);
      expect(sb.patches).toEqual([]);
    } finally {
      await gate.stop();
    }
  });

  it("does not patch on deny", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldHosts: ["held.example.com"],
      handler: () => "deny",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com.");
      expect(sb.patches).toEqual([]);
      const resolved = sb.emits.find((e) => e.event === "permission_resolved");
      expect(resolved?.payload).toMatchObject({ decision: { kind: "deny" } });
    } finally {
      await gate.stop();
    }
  });

  it("dedupes repeated denials of the same host within the TTL", async () => {
    const sb = fakeSandbox();
    let calls = 0;
    const gate = new EgressApprovalGate({
      heldHosts: ["held.example.com"],
      handler: () => {
        calls++;
        return "allow-always";
      },
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com");
      await fireWebhook(gate, "held.example.com");
      await fireWebhook(gate, "held.example.com");
      expect(calls).toBe(1);
    } finally {
      await gate.stop();
    }
  });

  it("endTurn() reverts an allow-once grant to deny", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldHosts: ["held.example.com"],
      handler: () => "allow-once",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com");
      expect(sb.patches).toEqual([[{ action: "allow", target: "held.example.com" }]]);

      await gate.endTurn();
      expect(sb.patches[1]).toEqual([{ action: "deny", target: "held.example.com" }]);

      // A second endTurn is a no-op (nothing left to revert).
      await gate.endTurn();
      expect(sb.patches).toHaveLength(2);
    } finally {
      await gate.stop();
    }
  });

  it("endTurn() leaves an allow-always grant in place", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldHosts: ["held.example.com"],
      handler: () => "allow-always",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com");
      await gate.endTurn();
      expect(sb.patches).toHaveLength(1);
    } finally {
      await gate.stop();
    }
  });
});
