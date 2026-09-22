import { describe, expect, it } from "vitest";
import { eventRenames, renameEventsStatement } from "../src/index";

describe("eventRenames", () => {
  it("covers the layers the SDK ledger actually holds", () => {
    const olds = eventRenames().map(([old]) => old);
    for (const name of [
      "sandbox_created",
      "exec_complete",
      "checkpoint_created",
      "credential_bound",
      "permission_requested",
      "step_start",
      "workflow_complete",
    ]) {
      expect(olds).toContain(name);
    }
  });

  it("excludes the layers it never held", () => {
    // alineod's swarm events and the harness stream live in alineod's own database.
    // Rewriting rows that cannot exist is wasted work at best, and wrong about which store
    // owns a name at worst.
    const olds = eventRenames().map(([old]) => old);
    for (const name of ["agent_spawned", "handle_settled", "tool_start", "text"]) {
      expect(olds).not.toContain(name);
    }
  });

  it("maps run_started to the workflow run, not the swarm one", () => {
    // The shared table leaves it unmapped precisely because it meant two different events.
    expect(eventRenames()).toContainEqual(["run_started", "workflow.started"]);
  });

  it("folds snapshot into the sandbox checkpoint it always recorded", () => {
    expect(eventRenames()).toContainEqual(["snapshot", "sandbox.checkpoint_created"]);
    expect(eventRenames()).toContainEqual(["checkpoint", "step.checkpointed"]);
  });
});

describe("renameEventsStatement", () => {
  it("is one statement, not one per name", () => {
    // `event` is unindexed on alineo_events, so a separate UPDATE per name would be a full
    // scan per name — about twenty-five of them.
    const { sql } = renameEventsStatement();
    expect(sql.match(/UPDATE/g)).toHaveLength(1);
    expect(sql.match(/WHEN event = \?/g)!.length).toBe(eventRenames().length);
  });

  it("keeps an ELSE, so unmatched rows are not nulled", () => {
    expect(renameEventsStatement().sql).toContain("ELSE event END");
  });

  it("scopes the UPDATE with a WHERE, so a re-run matches nothing", () => {
    // This is the whole idempotence mechanism: there is no schema_version table anywhere in
    // this repo, so "matches nothing the second time" IS the version check.
    expect(renameEventsStatement().sql).toContain("WHERE event IN (");
  });

  it("passes each old name twice — once for the CASE, once for the WHERE", () => {
    const { params } = renameEventsStatement();
    const pairs = eventRenames();
    expect(params).toHaveLength(pairs.length * 3);
    expect(params.slice(0, pairs.length * 2)).toEqual(pairs.flat());
    expect(params.slice(pairs.length * 2)).toEqual(pairs.map(([old]) => old));
  });
});
