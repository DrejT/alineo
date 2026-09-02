import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../src/types";
import { bash } from "../src/agent/session-control";
import type { AgentInternal } from "../src/agent/internal";

/** An `AgentInternal` just complete enough for `bash()` → `instrument()`. */
function fakeAgent(events: AgentEvent[]) {
  let endTurnCalls = 0;
  const a = {
    adapter: {
      // eslint-disable-next-line require-yield
      bash: async function* () {
        for (const ev of events) yield ev;
      },
    },
    sandbox: { emit: async () => {} },
    env: {},
    egressGate: {
      endTurn: async () => {
        endTurnCalls++;
      },
    },
  } as unknown as AgentInternal;
  return { a, endTurnCalls: () => endTurnCalls };
}

const events: AgentEvent[] = [
  { type: "text", text: "one" },
  { type: "text", text: "two" },
  { type: "text", text: "three" },
];

describe("session-control instrument() — egressGate.endTurn()", () => {
  it("runs on normal completion", async () => {
    const { a, endTurnCalls } = fakeAgent(events);
    for await (const _ of bash(a, "x")) void _;
    expect(endTurnCalls()).toBe(1);
  });

  it("runs when the consumer breaks out early", async () => {
    const { a, endTurnCalls } = fakeAgent(events);
    for await (const ev of bash(a, "x")) {
      if (ev.type === "text") break;
    }
    expect(endTurnCalls()).toBe(1);
  });

  it("runs when the consumer's loop body throws", async () => {
    const { a, endTurnCalls } = fakeAgent(events);
    let caught: unknown;
    try {
      for await (const _ of bash(a, "x")) {
        void _;
        throw new Error("boom");
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("boom");
    expect(endTurnCalls()).toBe(1);
  });
});
