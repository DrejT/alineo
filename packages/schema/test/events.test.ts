import { describe, expect, it } from "vitest";
import {
  allEvents,
  defineEvent,
  durableEvents,
  getEvent,
  isSubject,
  RENAMED_EVENTS,
  renamedEventType,
} from "../src/index";
import { z } from "zod";

describe("the registry", () => {
  it("is populated — importing the package loads every event file", () => {
    // A registry filled by import side effects fails silently if index.ts stops importing a
    // file: `allEvents()` just gets shorter. The floor makes that loud.
    expect(allEvents().length).toBeGreaterThan(50);
  });

  it("holds each type exactly once", () => {
    const types = allEvents().map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("names every event <subject>.<past_tense_verb> with a known subject", () => {
    for (const event of allEvents()) {
      expect(event.type).toMatch(/^[a-z]+\.[a-z][a-z_]*$/);
      expect(isSubject(event.type.split(".")[0]!)).toBe(true);
    }
  });

  it("covers every subject an event claims", () => {
    // The inverse of the check above: catches a subject added to SUBJECTS for an event that
    // was then never written.
    for (const event of allEvents()) {
      expect(getEvent(event.type)).toBe(event);
    }
  });

  it("keeps the high-volume stream events out of the ledger", () => {
    // These are deltas superseded by the event that follows them. Persisting them would
    // record, at great length, something the next row already says.
    const streamOnly = allEvents()
      .filter((e) => !e.durable)
      .map((e) => e.type);
    expect(streamOnly).toEqual(
      expect.arrayContaining(["exec.output", "message.updated", "tool.updated", "queue.updated"]),
    );
  });

  it("persists every control-plane event", () => {
    // alineod rebuilds its projections by folding these. One that is not written is state
    // that does not survive a restart — which would break its crash-only design outright.
    const controlPlane = allEvents().filter((e) =>
      ["run", "agent", "handle", "wait", "inbox", "notify", "budget"].includes(
        e.type.split(".")[0]!,
      ),
    );
    expect(controlPlane.length).toBeGreaterThan(0);
    for (const event of controlPlane) expect(event.durable).toBe(true);
  });

  it("returns only durable definitions from durableEvents()", () => {
    expect(durableEvents().every((e) => e.durable)).toBe(true);
    expect(durableEvents().length).toBeLessThan(allEvents().length);
  });
});

describe("defineEvent", () => {
  it("rejects a flat name", () => {
    expect(() =>
      defineEvent({ type: "agent_spawned", durable: true, version: 1, schema: z.object({}) }),
    ).toThrow(/<subject>\.<past_tense_verb>/);
  });

  it("rejects a subject that is not in SUBJECTS", () => {
    expect(() =>
      defineEvent({ type: "gremlin.spawned", durable: true, version: 1, schema: z.object({}) }),
    ).toThrow(/not in SUBJECTS/);
  });

  it("rejects a name that is a binary prefix rather than a subject", () => {
    expect(() =>
      defineEvent({
        type: "alineod.agent_spawned",
        durable: true,
        version: 1,
        schema: z.object({}),
      }),
    ).toThrow(/not in SUBJECTS/);
  });

  it("rejects a second definition of an existing type", () => {
    expect(() =>
      defineEvent({ type: "agent.spawned", durable: true, version: 1, schema: z.object({}) }),
    ).toThrow(/defined twice/);
  });

  it("is idempotent for the identical definition object", () => {
    // Module graphs can evaluate a file twice under some bundlers; re-registering the very
    // same object is not the mistake the duplicate check is for.
    const definition = getEvent("agent.spawned")!;
    expect(() => defineEvent(definition)).not.toThrow();
  });
});

describe("the rename table", () => {
  it("maps every old name to a registered event", () => {
    for (const [old, now] of Object.entries(RENAMED_EVENTS)) {
      expect(getEvent(now), `${old} → ${now} is not a registered event`).toBeDefined();
    }
  });

  it("leaves run_started unmapped, because it meant two different events", () => {
    // Workflow's run and alineod's run. A single mapping would be wrong in one store.
    expect(renamedEventType("run_started")).toBeUndefined();
  });

  it("returns undefined for a name that was never renamed", () => {
    expect(renamedEventType("agent.spawned")).toBeUndefined();
    expect(renamedEventType("not_an_event")).toBeUndefined();
  });

  it("folds the three checkpoint-ish names onto two events", () => {
    expect(renamedEventType("checkpoint_created")).toBe("sandbox.checkpoint_created");
    expect(renamedEventType("snapshot")).toBe("sandbox.checkpoint_created");
    expect(renamedEventType("checkpoint")).toBe("step.checkpointed");
  });

  it("sends `text` to message.updated, since it was a delta of exactly one message", () => {
    expect(renamedEventType("text")).toBe("message.updated");
    expect(renamedEventType("message_update")).toBe("message.updated");
  });
});
