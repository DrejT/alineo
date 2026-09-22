import { describe, expect, it } from "vitest";
import { AlineodEvent } from "../src/alineod";
import { allEvents } from "../src/index";

/**
 * `AlineodEvent` is derived from the registry rather than restated by hand. That removes one
 * duplication and introduces one hazard: the registry is filled by import side effects, and
 * an empty registry does not throw — it derives an empty union and every caller carries on.
 *
 * It happened. Giving the wire contract its own entry point put it in a separate bundle that
 * never loaded the definitions, and `specs/alineod/events.schema.json` went from 594 lines to
 * one without a single failing test.
 */
describe("the derived alineod event union", () => {
  const alineodSubjects = ["run", "agent", "handle", "wait", "inbox", "notify", "budget"];

  it("has a member for every control-plane definition", () => {
    const expected = allEvents().filter((e) => alineodSubjects.includes(e.type.split(".")[0]!));
    expect(expected.length).toBeGreaterThan(10);
    expect(AlineodEvent.options).toHaveLength(expected.length);
  });

  it("parses a real event", () => {
    expect(() => AlineodEvent.parse({ event: "run.started", runId: "r_1" })).not.toThrow();
  });

  it("rejects an event name that is not defined", () => {
    expect(() => AlineodEvent.parse({ event: "run.teleported", runId: "r_1" })).toThrow();
  });

  it("does not include forwarded harness events", () => {
    // They ride the same SSE stream tagged with agentId, but this union describes alineod's
    // own agent-lifecycle events.
    expect(() =>
      AlineodEvent.parse({ event: "tool.started", toolCallId: "t", toolName: "bash", args: {} }),
    ).toThrow();
  });
});
