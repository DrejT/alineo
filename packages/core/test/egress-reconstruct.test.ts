import { describe, expect, it } from "vitest";
import { reconstructEgressRules } from "../src/egress.ts";
import { LedgerEvent } from "../src/ledger.ts";
import type { LedgerEntry } from "../src/ledger.ts";

function entry(event: LedgerEvent, payload: unknown): LedgerEntry {
  return { ts: 0, name: "s", sandboxId: "sb", stepIndex: -1, event, payload };
}

describe("reconstructEgressRules", () => {
  it("returns [] for a history with no egress events", () => {
    expect(reconstructEgressRules([entry(LedgerEvent.SandboxCreated, {})])).toEqual([]);
  });

  it("collects added rules across multiple patches", () => {
    const rules = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleAdded, {
        rules: [
          { action: "allow", target: "b.com" },
          { action: "deny", target: "c.com" },
        ],
      }),
    ]);
    expect(rules).toEqual([
      { action: "allow", target: "a.com" },
      { action: "allow", target: "b.com" },
      { action: "deny", target: "c.com" },
    ]);
  });

  it("a later add for the same target wins", () => {
    const rules = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "deny", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
    ]);
    expect(rules).toEqual([{ action: "allow", target: "a.com" }]);
  });

  it("a later delete drops the rule", () => {
    const rules = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, {
        rules: [
          { action: "allow", target: "a.com" },
          { action: "allow", target: "b.com" },
        ],
      }),
      entry(LedgerEvent.EgressRuleRemoved, { targets: ["a.com"] }),
    ]);
    expect(rules).toEqual([{ action: "allow", target: "b.com" }]);
  });

  it("a re-add after a delete brings the rule back", () => {
    const rules = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleRemoved, { targets: ["a.com"] }),
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
    ]);
    expect(rules).toEqual([{ action: "allow", target: "a.com" }]);
  });
});
