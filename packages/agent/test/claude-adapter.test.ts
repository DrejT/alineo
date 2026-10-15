import { afterAll, describe, expect, it } from "bun:test";
import type { HarnessEvent } from "../src/harness";
import { startClaudeBridge, stopClaudeBridges } from "./fixtures/claude-bridge-harness";

afterAll(stopClaudeBridges);

async function collect(it: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeCodeAdapter against the built bridge", () => {
  it("carries the session id on run_start and the sdk uuid as messageId", async () => {
    const a = await startClaudeBridge({ kind: "text", text: "hello" });
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs[0]).toMatchObject({ type: "run_start", sessionRef: "sess-1" });
    expect(evs.find((e) => e.type === "message_start")).toMatchObject({ messageId: "a1" });
  });

  it("sends the text once when it arrives as deltas and again in the full message", async () => {
    const a = await startClaudeBridge({ kind: "text", text: "hello" });
    const evs = await collect(a.runTurn({ message: "x" }));
    const text = evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    expect(text).toBe("hello");
  });

  it("names the tool on tool_end from the earlier tool_start", async () => {
    const a = await startClaudeBridge({ kind: "tool", toolName: "Bash", result: "42" });
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.find((e) => e.type === "tool_end")).toMatchObject({
      toolCallId: "tu1",
      toolName: "Bash",
      result: "42",
      isError: false,
    });
  });

  it("forks at the messageId it issued, and gets a new session ref", async () => {
    const a = await startClaudeBridge({ kind: "text", text: "hello" });
    const evs = await collect(a.runTurn({ message: "x" }));
    const mid = evs.flatMap((e) => (e.type === "message_start" ? [e.messageId] : []))[0];
    expect(mid).toBe("a1");
    const forked = await a.forkAt(mid ?? "");
    expect(forked.sessionRef).toBe("sess-1-fork-a1");
  });

  it("ends a turn once when the sdk throws after an error result", async () => {
    // Found by running the real SDK with a bad key: result(is_error) and then a throw.
    const a = await startClaudeBridge({
      kind: "error-result-then-throw",
      message: "Invalid API key",
    } as never);
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "error" });
    expect(evs.filter((e) => e.type === "error")).toHaveLength(1);
    // The synthesised API-error message is reported by the result, not also as prose.
    expect(evs.some((e) => e.type === "text")).toBe(false);
  });

  it("refuses a second turn while one is running", async () => {
    const a = await startClaudeBridge({ kind: "hang" });
    const first = collect(a.runTurn({ message: "one" }));
    await Bun.sleep(100);
    const second = await collect(a.runTurn({ message: "two" }));
    expect(second.some((e) => e.type === "error")).toBe(true);
    expect(second.at(-1)).toMatchObject({ type: "done", reason: "error" });
    await a.abort();
    await first;
  });

  it("allows a call the policy allows, with no permission_request", async () => {
    const a = await startClaudeBridge(
      { kind: "permission", tool: "bash", target: "ls" },
      {
        permissions: {
          default: "ask",
          rules: [{ tool: "bash", action: "allow" }],
          disabledTools: [],
          restrictToTools: [],
        },
      },
    );
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.some((e) => e.type === "permission_request")).toBe(false);
    expect(evs.some((e) => e.type === "tool_end" && !e.isError)).toBe(true);
  });

  it("blocks a call the policy denies, with no permission_request", async () => {
    const a = await startClaudeBridge(
      { kind: "permission", tool: "bash", target: "rm -rf /" },
      {
        permissions: { default: "allow", rules: [], disabledTools: ["bash"], restrictToTools: [] },
      },
    );
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.some((e) => e.type === "permission_request")).toBe(false);
    expect(evs.some((e) => e.type === "tool_end" && !e.isError)).toBe(false);
  });
});
