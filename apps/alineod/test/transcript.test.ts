/** GET /agents/:id/transcript — the ledger's `agent_end` messages, flattened for a person to read. */
import { afterEach, expect, test } from "bun:test";
import { call, startRun } from "./helpers";
import { fakeSdk } from "./fakes";
import { appendRow, db } from "../src/state/db";

afterEach(() => fakeSdk.reset());

const text = (t: string) => ({ type: "text", text: t });

/** A turn shaped like Pi's `agent_end`: prompt, a tool call, its output, then an errored reply. */
const TURN = [
  { role: "user", content: [text("run the judge")] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should run it" },
      text("Running it."),
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "python3 evaluate.py" } },
    ],
    stopReason: "toolUse",
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [text("val_bpc: 2.51")],
    isError: false,
  },
  {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Service temporarily overloaded",
  },
];

function endTurn(runId: string, agentId: string, messages: unknown) {
  return appendRow(runId, agentId, "agent_end", { agentId, messages });
}

test("an agent with no finished turns has an empty transcript", async () => {
  const { rootAgentId } = await startRun({ prompt: "work" });
  const res = await call("GET", `/agents/${rootAgentId}/transcript`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ agentId: rootAgentId, turns: [] });
});

test("404 for an agent that doesn't exist", async () => {
  const res = await call("GET", "/agents/a_nope/transcript");
  expect(res.status).toBe(404);
});

test("flattens messages: text, tool calls, tool output and the API's error", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "work" });
  const row = endTurn(runId, rootAgentId, TURN);

  const res = await call("GET", `/agents/${rootAgentId}/transcript`);
  expect(res.status).toBe(200);
  expect(res.body.turns).toHaveLength(1);
  expect(res.body.turns[0]).toMatchObject({ seq: row.seq, ts: row.ts });
  expect(res.body.turns[0].messages).toEqual([
    { role: "user", text: "run the judge" },
    {
      role: "assistant",
      text: "Running it.",
      toolCalls: [{ name: "bash", arguments: { command: "python3 evaluate.py" } }],
      stopReason: "toolUse",
      errorMessage: null,
    },
    { role: "tool", toolName: "bash", text: "val_bpc: 2.51", isError: false },
    {
      role: "assistant",
      text: "",
      toolCalls: [],
      stopReason: "error",
      errorMessage: "Service temporarily overloaded",
    },
  ]);
});

test("keeps turns in order, and only this agent's", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "work" });
  endTurn(runId, rootAgentId, [{ role: "user", content: [text("first")] }]);
  endTurn(runId, "a_someone_else", [{ role: "user", content: [text("not mine")] }]);
  endTurn(runId, rootAgentId, [{ role: "user", content: [text("second")] }]);

  const res = await call("GET", `/agents/${rootAgentId}/transcript`);
  expect(res.body.turns.map((t: { messages: { text: string }[] }) => t.messages[0]!.text)).toEqual([
    "first",
    "second",
  ]);
});

test("long output is cut unless ?full=1, which also returns the model's thinking", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "work" });
  const long = "x".repeat(5_000);
  endTurn(runId, rootAgentId, [
    { role: "toolResult", toolName: "bash", content: [text(long)], isError: false },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hmm" }, text("ok")],
      stopReason: "stop",
    },
  ]);

  const short = await call("GET", `/agents/${rootAgentId}/transcript`);
  const [tool, reply] = short.body.turns[0].messages;
  expect(tool.text.length).toBeLessThan(2_200);
  expect(tool.text).toContain("3000 more characters");
  expect(reply.thinking).toBeUndefined();

  const full = await call("GET", `/agents/${rootAgentId}/transcript?full=1`);
  const [fullTool, fullReply] = full.body.turns[0].messages;
  expect(fullTool.text).toBe(long);
  expect(fullReply.thinking).toBe("hmm");
});

test("skips a damaged row and messages it doesn't recognise", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "work" });
  appendRow(runId, rootAgentId, "agent_end", "not an object");
  rawAgentEnd(runId, rootAgentId, "{not json");
  endTurn(runId, rootAgentId, [
    { role: "system", content: "?" },
    null,
    { role: "user", content: "hi" },
  ]);

  const res = await call("GET", `/agents/${rootAgentId}/transcript`);
  expect(res.status).toBe(200);
  const withMessages = res.body.turns.filter((t: { messages: unknown[] }) => t.messages.length > 0);
  expect(withMessages).toHaveLength(1);
  expect(withMessages[0].messages).toEqual([{ role: "user", text: "hi" }]);
});

// A payload that isn't valid JSON can't go through appendRow (it serialises), so write the row.
function rawAgentEnd(runId: string, agentId: string, payload: string) {
  db.query(
    "INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?, ?, ?, 'agent_end', ?)",
  ).run(runId, agentId, Date.now(), payload);
}
