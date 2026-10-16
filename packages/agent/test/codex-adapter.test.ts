import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { HarnessEvent } from "../src/harness";
import { startCodexBridge, stopCodexBridges } from "./fixtures/codex-bridge-harness";

setDefaultTimeout(20_000);
afterAll(stopCodexBridges);

async function collect(it: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("CodexAdapter against the built bridge", () => {
  it("carries the thread id on run_start and the turn id as messageId", async () => {
    const a = await startCodexBridge({ kind: "text", text: "hello" });
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs[0]).toMatchObject({ type: "run_start", sessionRef: "th-1" });
    expect(evs.find((e) => e.type === "message_start")).toMatchObject({ messageId: "tu-1" });
    expect(evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("")).toBe("hello");
  });

  it("names a command execution bash, with its output as the result", async () => {
    const a = await startCodexBridge({ kind: "tool", toolName: "ls", result: "a b" });
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.find((e) => e.type === "tool_start")).toMatchObject({
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(evs.find((e) => e.type === "tool_end")).toMatchObject({
      toolName: "bash",
      result: "a b",
      isError: false,
    });
  });

  it("accepts a steer while a turn runs, and the turn can then finish", async () => {
    const a = await startCodexBridge({ kind: "hang", finishOnSteer: true });
    const run = collect(a.runTurn({ message: "work" }));
    await Bun.sleep(150);
    await a.steer("also say hello");
    const evs = await run;
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "completed" });
  });

  it("refuses a steer between turns", async () => {
    const a = await startCodexBridge({ kind: "text", text: "x" });
    let message = "";
    try {
      await a.steer("go left");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("no turn in progress");
  });

  it("forks at the turn id it issued, and compacts", async () => {
    const a = await startCodexBridge({ kind: "text", text: "hello" });
    const evs = await collect(a.runTurn({ message: "x" }));
    const mid = evs.flatMap((e) => (e.type === "message_start" ? [e.messageId] : []))[0];
    expect(mid).toBe("tu-1");
    expect((await a.forkAt(mid ?? "")).sessionRef).toBe("th-fork-tu-1");
    await a.compact();
  });

  it("reports a failed turn as one error then one done", async () => {
    const a = await startCodexBridge({ kind: "fail", message: "model overloaded" });
    const evs = await collect(a.runTurn({ message: "x" }));
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
    // The real app-server reports it twice (error notification, then turn/completed).
    expect(evs.filter((e) => e.type === "error")).toHaveLength(1);
    expect(evs.find((e) => e.type === "error")).toMatchObject({ message: "model overloaded" });
  });

  it("declines a call the policy denies, without asking", async () => {
    const a = await startCodexBridge(
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
