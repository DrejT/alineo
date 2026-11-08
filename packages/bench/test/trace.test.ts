import { describe, expect, it } from "vitest";
import { normalizeOutput } from "../src/normalize.ts";
import { parseSse, renderArgs, traceFromEvents } from "../src/trace.ts";

// Shapes captured from a real alineod run (Pi 1.2.0 on Gemini): tool start has args, tool end has result.
const sse = [
  ": ping",
  'event: agent.provisioned\ndata: {"agentId":"a_1","sandboxId":"sb","provider":"opensandbox"}',
  'event: harness.tool_execution_start\ndata: {"agentId":"a_1","toolCallId":"c1","toolName":"bash","args":{"command":"echo hello > /tmp/probe.txt && cat /tmp/probe.txt","timeout":null}}',
  'event: harness.tool_execution_end\ndata: {"agentId":"a_1","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"hello\\n"}],"structuredContent":{"output":"hello\\n","truncated":false,"exit_code":0}},"isError":false}',
  'event: harness.tool_execution_start\ndata: {"agentId":"a_2","toolCallId":"c9","toolName":"bash","args":{"command":"another agent"}}',
  "event: x\ndata: {not json",
].join("\n\n");

describe("trace from the run event stream", () => {
  it("parses SSE blocks and skips pings and malformed data", () => {
    const evs = parseSse(sse);
    expect(evs.map((e) => e.event)).toEqual([
      "agent.provisioned",
      "harness.tool_execution_start",
      "harness.tool_execution_end",
      "harness.tool_execution_start",
    ]);
  });
  it("renders one CALL and one RESULT line for the right agent only", () => {
    const t = traceFromEvents(parseSse(sse), "a_1");
    expect(t.split("\n")).toEqual([
      'CALL bash {"command":"echo hello > /tmp/probe.txt && cat /tmp/probe.txt","timeout":null}',
      "RESULT bash exit=0: hello",
    ]);
    expect(t).not.toContain("another agent");
  });
  it("reports an error result and a missing trace", () => {
    const err = [
      'event: e\ndata: {"agentId":"a","toolName":"bash","result":{"structuredContent":{"output":"boom","exit_code":2}},"isError":true}',
    ].join("\n\n");
    expect(traceFromEvents(parseSse(err), "a")).toBe("RESULT bash (error) exit=2: boom");
    expect(traceFromEvents([], "a")).toBe("(no tool calls recorded)");
  });
});

describe("output comparison", () => {
  it("ignores CRLF vs LF and trailing whitespace, but not content", () => {
    expect(normalizeOutput("a,b\r\n1,2\r\n")).toBe(normalizeOutput("a,b\n1,2"));
    expect(normalizeOutput("a,b\r\n1,3")).not.toBe(normalizeOutput("a,b\n1,2"));
  });
});

describe("tool-call arguments in the trace", () => {
  it("keeps a written file's content so claims about the code can be checked", () => {
    const code = "import sys\n" + "x = 1\n".repeat(100);
    const out = renderArgs({ path: "/tmp/work/a.py", content: code });
    expect(out).toContain("/tmp/work/a.py");
    expect(out).toContain("import sys");
    expect(out.length).toBeGreaterThan(600); // the old limit was 260 characters in total
  });
  it("still bounds very large content and short commands stay short", () => {
    expect(renderArgs({ path: "p", content: "y".repeat(10_000) }).length).toBeLessThan(3000);
    expect(renderArgs({ command: "ls -l" })).toBe('{"command":"ls -l"}');
  });
});
