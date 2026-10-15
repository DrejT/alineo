import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { fromPiEvent, PI_CAPABILITIES, type HarnessEvent } from "../src/harness";
import type { AgentEvent } from "../src/types";

/** One real-shaped example of every `AgentEvent` the bridge can send. */
const samples: Record<AgentEvent["type"], AgentEvent> = {
  text: { type: "text", text: "hi" },
  tool_start: { type: "tool_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
  tool_update: { type: "tool_update", toolCallId: "c1", toolName: "bash", partialResult: "a" },
  tool_end: { type: "tool_end", toolCallId: "c1", toolName: "bash", result: "a", isError: false },
  extension_ui: { type: "extension_ui", method: "notify", params: {}, isDialog: false },
  permission_request: {
    type: "permission_request",
    requestId: "r1",
    tool: "bash",
    target: "ls",
    title: "Run bash: ls",
  },
  permission_resolved: {
    type: "permission_resolved",
    requestId: "r1",
    decision: { kind: "once" },
  },
  auto_retry_start: {
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "429",
  },
  auto_retry_end: { type: "auto_retry_end", success: false, attempt: 3, finalError: "503" },
  agent_start: { type: "agent_start" },
  agent_end: { type: "agent_end", messages: [] },
  turn_start: { type: "turn_start", turnIndex: 0, timestamp: 1 },
  turn_end: { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] },
  message_start: { type: "message_start", message: { role: "assistant", id: "m1" } },
  message_update: {
    type: "message_update",
    message: {},
    delta: { type: "thinking_delta", delta: "hmm" },
  },
  message_end: { type: "message_end", message: { role: "assistant" } },
  queue_update: { type: "queue_update", steering: ["a"], followUp: [] },
  compaction_start: { type: "compaction_start", reason: "manual" },
  compaction_end: {
    type: "compaction_end",
    reason: "threshold",
    result: null,
    aborted: false,
    willRetry: true,
  },
  extension_error: {
    type: "extension_error",
    extensionPath: "/x",
    event: "tool_call",
    error: "boom",
  },
};

describe("fromPiEvent", () => {
  it("maps every AgentEvent type, and keeps the Pi event as raw", () => {
    for (const [type, ev] of Object.entries(samples)) {
      const out = fromPiEvent(ev);
      expect(out.length, type).toBe(1);
      expect(out[0]?.raw, type).toBe(ev);
    }
  });

  it("maps agent_end to the one terminal event", () => {
    expect(fromPiEvent(samples.agent_end)[0]).toMatchObject({ type: "done", reason: "completed" });
    const terminals = Object.values(samples)
      .flatMap((e) => fromPiEvent(e))
      .filter((e) => e.type === "done");
    expect(terminals).toHaveLength(1);
  });

  it("turns thinking_delta into reasoning", () => {
    expect(fromPiEvent(samples.message_update)[0]).toMatchObject({
      type: "reasoning",
      text: "hmm",
    });
  });

  it("keeps a text_delta as a vendor event: the text itself arrives as its own text event", () => {
    const ev: AgentEvent = {
      type: "message_update",
      message: {},
      delta: { type: "text_delta", delta: "hi" },
    };
    expect(fromPiEvent(ev)[0]).toMatchObject({
      type: "vendor",
      harness: "pi",
      name: "message_update",
      raw: ev,
    });
  });

  it("gives the message id when Pi has one, and null when it has none", () => {
    expect(fromPiEvent(samples.message_start)[0]).toMatchObject({
      type: "message_start",
      messageId: "m1",
    });
    expect(fromPiEvent(samples.message_end)[0]).toMatchObject({
      type: "message_end",
      messageId: null,
    });
  });

  it("sends extension events to vendor, under the pi harness", () => {
    const out: HarnessEvent | undefined = fromPiEvent(samples.extension_ui)[0];
    expect(out).toMatchObject({ type: "vendor", harness: "pi", name: "extension_ui" });
  });

  it("carries the retry and compaction fields that belong to each phase", () => {
    expect(fromPiEvent(samples.auto_retry_start)[0]).toMatchObject({
      type: "retry",
      phase: "start",
      maxAttempts: 3,
      delayMs: 2000,
      error: "429",
    });
    expect(fromPiEvent(samples.auto_retry_end)[0]).toMatchObject({
      type: "retry",
      phase: "end",
      success: false,
      error: "503",
    });
    expect(fromPiEvent(samples.compaction_end)[0]).toMatchObject({
      type: "compaction",
      phase: "end",
      willRetry: true,
    });
  });
});

describe("PI_CAPABILITIES", () => {
  const bridge = readFileSync(
    fileURLToPath(new URL("../src/bridge/pi-bridge.ts", import.meta.url)),
    "utf8",
  );
  // The route in the bridge that backs each capability. A declared `true` with no route
  // behind it is the lie this test exists to catch.
  const backing: Record<keyof typeof PI_CAPABILITIES, string> = {
    steer: '"/steer"',
    followUp: '"/follow-up"',
    resume: '"--continue"',
    fork: '"/fork"',
    compact: '"/compact"',
    setModel: '"/set-model"',
    permissions: '"/permission-response"',
    reasoning: "thinking_delta",
  };

  it("declares every capability a harness can have", () => {
    expect(Object.keys(PI_CAPABILITIES).sort()).toEqual(Object.keys(backing).sort());
  });

  for (const [cap, needle] of Object.entries(backing)) {
    it(`backs ${cap} with something real`, () => {
      const declared = PI_CAPABILITIES[cap as keyof typeof PI_CAPABILITIES];
      // `reasoning` is read by the host mapper, not routed by the bridge.
      const source =
        cap === "reasoning"
          ? readFileSync(
              fileURLToPath(new URL("../src/harness/pi-events.ts", import.meta.url)),
              "utf8",
            )
          : bridge;
      expect(declared ? source.includes(needle) : true).toBe(true);
    });
  }
});
