import { describe, expect, it } from "vitest";
import { isSubject, isVerb, parseName, SUBJECTS, VERBS } from "../src/index";

describe("the lists", () => {
  it("has no duplicates", () => {
    expect(new Set(SUBJECTS).size).toBe(SUBJECTS.length);
    expect(new Set(VERBS).size).toBe(VERBS.length);
  });

  it("spells every name in a form a route, tool or event type can carry", () => {
    // No spaces, separators or leading capitals: a subject or verb has to survive being
    // pasted into `agent_spawn`, `agent.spawned` and `/agents/:id/steer` unchanged.
    for (const name of [...SUBJECTS, ...VERBS]) {
      expect(name).toMatch(/^[a-z][a-zA-Z]*$/);
    }
  });

  it("never lists both a subject and its plural", () => {
    // HTTP pluralizes its collection segment (`/agents/:id`) and no other surface does, so a
    // stray `agents` alongside `agent` would let a route name typecheck on both sides of the
    // split. (`egress` is not a plural; hence the pairwise check rather than a suffix rule.)
    for (const subject of SUBJECTS) {
      expect(SUBJECTS).not.toContain(`${subject}s`);
    }
  });
});

describe("isSubject / isVerb", () => {
  it("accepts what is in the lists", () => {
    expect(isSubject("agent")).toBe(true);
    expect(isVerb("spawn")).toBe(true);
  });

  it("rejects the names this vocabulary exists to retire", () => {
    expect(isVerb("load")).toBe(false); // → start
    expect(isVerb("kill")).toBe(false); // → stop
    expect(isVerb("create")).toBe(false); // → start
    expect(isVerb("delete")).toBe(false); // → stop (the route keeps the ledger)
    expect(isVerb("clone")).toBe(false); // → duplicateSession
    expect(isSubject("alineod")).toBe(false); // a binary, not a subject
    expect(isSubject("alineo")).toBe(false);
    expect(isSubject("agents")).toBe(false); // plural belongs to HTTP paths only
  });

  it("does not treat a subject as a verb, or the reverse", () => {
    expect(isVerb("agent")).toBe(false);
    expect(isSubject("spawn")).toBe(false);
  });
});

describe("parseName", () => {
  it("splits an MCP tool name", () => {
    expect(parseName("agent_spawn", "_")).toEqual({ subject: "agent", verb: "spawn" });
    expect(parseName("run_start", "_")).toEqual({ subject: "run", verb: "start" });
  });

  it("splits an event type", () => {
    expect(parseName("sandbox.checkpoint", ".")).toEqual({
      subject: "sandbox",
      verb: "checkpoint",
    });
  });

  it("keeps a camelCase verb intact", () => {
    expect(parseName("session_branchSession", "_")).toEqual({
      subject: "session",
      verb: "branchSession",
    });
  });

  it("rejects the tool names in use today", () => {
    expect(parseName("alineod_create_run", "_")).toBeNull();
    expect(parseName("alineod_spawn_agent", "_")).toBeNull();
    expect(parseName("alineo_add_spec", "_")).toBeNull();
  });

  it("rejects a name with a good half and a bad half", () => {
    expect(parseName("agent_obliterate", "_")).toBeNull();
    expect(parseName("gremlin_spawn", "_")).toBeNull();
  });

  it("rejects a name with no separator, or an empty half", () => {
    expect(parseName("init", "_")).toBeNull();
    expect(parseName("_spawn", "_")).toBeNull();
    expect(parseName("agent_", "_")).toBeNull();
  });

  it("does not split on the wrong separator", () => {
    expect(parseName("agent_spawn", ".")).toBeNull();
    expect(parseName("agent.spawn", "_")).toBeNull();
  });
});
