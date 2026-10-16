import { describe, expect, it } from "bun:test";
import { FakeHarness, fromPiEvent, legacyStream, toAgentEvent } from "../src/harness";
import { BridgeDisconnectedError } from "../src/errors";
import type { AgentEvent } from "../src/types";

/** Every AgentEvent type the Pi bridge sends. */
const piEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "text", text: "hi" },
  { type: "message_start", message: { role: "assistant" } },
  { type: "message_update", message: {}, delta: { type: "text_delta", delta: "hi" } },
  { type: "message_update", message: {}, delta: { type: "thinking_delta", delta: "hm" } },
  { type: "message_update", message: {}, delta: { type: "tool_call_delta", delta: "{" } },
  { type: "message_end", message: {} },
  { type: "tool_start", toolCallId: "c", toolName: "bash", args: {} },
  { type: "tool_update", toolCallId: "c", toolName: "bash", partialResult: "a" },
  { type: "tool_end", toolCallId: "c", toolName: "bash", result: "a", isError: false },
  { type: "extension_ui", method: "notify", params: {}, isDialog: false },
  { type: "extension_error", extensionPath: "/x", event: "e", error: "boom" },
  { type: "permission_request", requestId: "r", tool: "bash", target: "ls", title: "t" },
  { type: "permission_resolved", requestId: "r", decision: { kind: "once" } },
  { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5, errorMessage: "429" },
  { type: "auto_retry_end", success: true, attempt: 1 },
  { type: "turn_start", turnIndex: 0, timestamp: 1 },
  { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] },
  { type: "queue_update", steering: [], followUp: [] },
  { type: "compaction_start", reason: "manual" },
  { type: "compaction_end", reason: "manual", result: null, aborted: false, willRetry: false },
  { type: "agent_end", messages: [] },
];

describe("toAgentEvent", () => {
  it("gives back every Pi event exactly as it came, through fromPiEvent", () => {
    for (const ev of piEvents) {
      const projected = fromPiEvent(ev).map((h) => toAgentEvent(h, "pi"));
      expect(projected, ev.type).toEqual([ev]);
    }
  });

  it("projects a harness with no raw AgentEvent from the neutral fields", () => {
    expect(toAgentEvent({ type: "text", text: "x" }, "fake")).toEqual({ type: "text", text: "x" });
    expect(
      toAgentEvent(
        { type: "tool_end", toolCallId: "1", toolName: "b", result: 1, isError: true },
        "fake",
      ),
    ).toEqual({ type: "tool_end", toolCallId: "1", toolName: "b", result: 1, isError: true });
    expect(toAgentEvent({ type: "done", reason: "completed" }, "fake")).toEqual({
      type: "agent_end",
      messages: [],
    });
  });

  it("gives an aborted or failed turn no agent_end", () => {
    expect(toAgentEvent({ type: "done", reason: "aborted" }, "fake")).toBeNull();
    expect(toAgentEvent({ type: "done", reason: "error" }, "fake")).toBeNull();
  });

  it("does not trust raw from a harness that is not Pi", () => {
    const foreign = { type: "text", text: "from the sdk" } as const;
    expect(toAgentEvent({ type: "text", text: "neutral", raw: foreign }, "claude")).toEqual({
      type: "text",
      text: "neutral",
    });
  });
});

describe("legacyStream", () => {
  async function drain(s: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of s) out.push(e);
    return out;
  }

  it("yields the AgentEvents of a turn", async () => {
    const a = new FakeHarness({ kind: "text", text: "hello" });
    const evs = await drain(legacyStream(a, { message: "x" }));
    expect(evs.map((e) => e.type)).toEqual(["agent_start", "text", "agent_end"]);
  });

  it("throws the original error when a turn fails, as prompt() always did", async () => {
    const boom = new BridgeDisconnectedError("http://b");
    const failing = {
      id: "pi",
      runTurn: async function* () {
        yield { type: "error" as const, message: boom.message, raw: boom };
        yield { type: "done" as const, reason: "error" as const };
      },
    };
    let caught: unknown;
    try {
      await drain(legacyStream(failing as never, { message: "x" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
  });

  it("throws a plain Error carrying the message when there is no error object", async () => {
    const a = new FakeHarness({ kind: "fail", message: "no model" });
    let caught: unknown;
    try {
      await drain(legacyStream(a, { message: "x" }));
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("no model");
  });
});
