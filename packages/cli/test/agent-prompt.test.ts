import { describe, it, expect } from "bun:test";
import type { Alineo, AgentEvent } from "alineo";
import { collectReply } from "../src/agent-prompt";

function fakeAgent(events: AgentEvent[]): Alineo {
  return {
    // eslint-disable-next-line typescript/require-await -- must be async to match Alineo.prompt's real signature; nothing here needs to await
    prompt: async function* () {
      for (const ev of events) yield ev;
    },
  } as unknown as Alineo;
}

describe("collectReply", () => {
  it("collects text deltas into one string", async () => {
    const agent = fakeAgent([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world." },
    ]);
    const result = await collectReply(agent, "hi");
    expect(result.text).toBe("Hello, world.");
    expect(result.toolCalls).toEqual([]);
  });

  it("records tool calls even when no text is ever produced", async () => {
    const agent = fakeAgent([
      { type: "tool_start", toolCallId: "1", toolName: "browser_open", args: {} },
      { type: "tool_end", toolCallId: "1", toolName: "browser_open", result: {}, isError: false },
    ]);
    const result = await collectReply(agent, "log in");
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ name: "browser_open", isError: false }]);
  });

  it("records failed tool calls too", async () => {
    const agent = fakeAgent([
      {
        type: "tool_end",
        toolCallId: "1",
        toolName: "browser_click",
        result: { error: "no such element" },
        isError: true,
      },
    ]);
    const result = await collectReply(agent, "click it");
    expect(result.toolCalls).toEqual([{ name: "browser_click", isError: true }]);
  });
});
