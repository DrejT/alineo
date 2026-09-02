import { describe, expect, it } from "bun:test";
import type { CredentialBinding, SandboxHandle } from "@alineo-labs/core";
import {
  EgressApprovalGate,
  type EgressDecision,
  type HeldCredential,
} from "../src/agent/egress-approval";

interface FakeSandbox {
  handle: SandboxHandle;
  patches: Array<Array<{ action: string; target: string }>>;
  credsSet: string[];
  credsRemoved: string[];
  emits: Array<{ event: string; payload: unknown }>;
}

function fakeSandbox(): FakeSandbox {
  const patches: FakeSandbox["patches"] = [];
  const credsSet: string[] = [];
  const credsRemoved: string[] = [];
  const emits: FakeSandbox["emits"] = [];
  const handle = {
    egress: {
      patch: async (rules: Array<{ action: string; target: string }>) => {
        patches.push(rules);
      },
    },
    credentials: {
      set: async (name: string) => {
        credsSet.push(name);
      },
      remove: async (name: string) => {
        credsRemoved.push(name);
      },
    },
    emit: async (event: string, _step: number, payload: unknown) => {
      emits.push({ event, payload });
    },
  } as unknown as SandboxHandle;
  return { handle, patches, credsSet, credsRemoved, emits };
}

function cred(name: string, host: string): HeldCredential {
  const binding: CredentialBinding = { host, injection: { type: "header", name: "Authorization" } };
  return { name, value: `${name}-value`, binding };
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
  it("on approval: opens the host first, then registers the credential", async () => {
    const sb = fakeSandbox();
    const seen: string[] = [];
    const gate = new EgressApprovalGate({
      heldCredentials: [cred("gh", "api.github.com")],
      handler: (req): EgressDecision => {
        seen.push(req.host);
        return "allow-always";
      },
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "api.github.com");
      expect(seen).toEqual(["api.github.com"]);
      expect(sb.patches).toEqual([[{ action: "allow", target: "api.github.com" }]]);
      expect(sb.credsSet).toEqual(["gh"]);
      expect(sb.emits.map((e) => e.event)).toEqual(["permission_requested", "permission_resolved"]);
    } finally {
      await gate.stop();
    }
  });

  it("ignores a host it is not holding", async () => {
    const sb = fakeSandbox();
    let called = false;
    const gate = new EgressApprovalGate({
      heldCredentials: [cred("gh", "api.github.com")],
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
      expect(sb.credsSet).toEqual([]);
    } finally {
      await gate.stop();
    }
  });

  it("on deny: neither opens the host nor registers the credential", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldCredentials: [cred("gh", "held.example.com")],
      handler: () => "deny",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com.");
      expect(sb.patches).toEqual([]);
      expect(sb.credsSet).toEqual([]);
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
      heldCredentials: [cred("gh", "held.example.com")],
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

  it("endTurn() reverses an allow-once grant: removes the credential, re-denies the host", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldCredentials: [cred("gh", "held.example.com")],
      handler: () => "allow-once",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com");
      expect(sb.patches).toEqual([[{ action: "allow", target: "held.example.com" }]]);
      expect(sb.credsSet).toEqual(["gh"]);

      await gate.endTurn();
      expect(sb.credsRemoved).toEqual(["gh"]);
      expect(sb.patches[1]).toEqual([{ action: "deny", target: "held.example.com" }]);

      await gate.endTurn(); // no-op the second time
      expect(sb.patches).toHaveLength(2);
    } finally {
      await gate.stop();
    }
  });

  it("endTurn() leaves an allow-always grant in place", async () => {
    const sb = fakeSandbox();
    const gate = new EgressApprovalGate({
      heldCredentials: [cred("gh", "held.example.com")],
      handler: () => "allow-always",
    });
    await gate.start();
    gate.bind(sb.handle);
    try {
      await fireWebhook(gate, "held.example.com");
      await gate.endTurn();
      expect(sb.patches).toHaveLength(1);
      expect(sb.credsRemoved).toEqual([]);
    } finally {
      await gate.stop();
    }
  });
});
