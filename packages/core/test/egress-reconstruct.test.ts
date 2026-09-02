import { describe, expect, it } from "vitest";
import { reconstructEgressRules } from "../src/egress.ts";
import { LedgerEvent } from "../src/ledger.ts";
import type { LedgerEntry } from "../src/ledger.ts";

function entry(event: LedgerEvent, payload: unknown): LedgerEntry {
  return { ts: 0, name: "s", sandboxId: "sb", stepIndex: -1, event, payload };
}

describe("reconstructEgressRules", () => {
  it("returns empty for a history with no egress events", () => {
    expect(reconstructEgressRules([entry(LedgerEvent.SandboxCreated, {})])).toEqual({
      apply: [],
      remove: [],
    });
  });

  it("collects added rules across multiple patches", () => {
    const { apply, remove } = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleAdded, {
        rules: [
          { action: "allow", target: "b.com" },
          { action: "deny", target: "c.com" },
        ],
      }),
    ]);
    expect(apply).toEqual([
      { action: "allow", target: "a.com" },
      { action: "allow", target: "b.com" },
      { action: "deny", target: "c.com" },
    ]);
    expect(remove).toEqual([]);
  });

  it("a later add for the same target wins", () => {
    const { apply } = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "deny", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
    ]);
    expect(apply).toEqual([{ action: "allow", target: "a.com" }]);
  });

  it("a later delete drops a runtime-added rule and reports the target as removed", () => {
    const { apply, remove } = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, {
        rules: [
          { action: "allow", target: "a.com" },
          { action: "allow", target: "b.com" },
        ],
      }),
      entry(LedgerEvent.EgressRuleRemoved, { targets: ["a.com"] }),
    ]);
    expect(apply).toEqual([{ action: "allow", target: "b.com" }]);
    expect(remove).toEqual(["a.com"]);
  });

  it("reports a delete of a target that was never added (i.e. a boot-policy rule)", () => {
    const { apply, remove } = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleRemoved, { targets: ["boot.example.com"] }),
    ]);
    expect(apply).toEqual([]);
    expect(remove).toEqual(["boot.example.com"]);
  });

  it("a re-add after a delete brings the rule back and clears the removal", () => {
    const { apply, remove } = reconstructEgressRules([
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
      entry(LedgerEvent.EgressRuleRemoved, { targets: ["a.com"] }),
      entry(LedgerEvent.EgressRuleAdded, { rules: [{ action: "allow", target: "a.com" }] }),
    ]);
    expect(apply).toEqual([{ action: "allow", target: "a.com" }]);
    expect(remove).toEqual([]);
  });
});
