// A stand-in for @anthropic-ai/claude-agent-sdk. Plays the scenario in ALINEO_STUB_SCENARIO
// with the message shapes the real SDK documents (system init, stream_event, assistant, user,
// result). It exists so claude-bridge.ts can run end to end with no model and no key.
const sc = JSON.parse(process.env.ALINEO_STUB_SCENARIO || '{"kind":"text","text":"hi"}');

export function query({ prompt, options }) {
  const ac = options.abortController;
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "sess-1" };
    switch (sc.kind) {
      case "text":
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: sc.text } },
        };
        yield {
          type: "assistant",
          uuid: "a1",
          message: { content: [{ type: "text", text: sc.text }] },
        };
        yield { type: "result", subtype: "success", is_error: false, result: sc.text };
        return;
      case "tool":
        yield {
          type: "assistant",
          uuid: "a1",
          message: { content: [{ type: "tool_use", id: "tu1", name: sc.toolName, input: {} }] },
        };
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: sc.result }] },
        };
        yield { type: "result", subtype: "success", is_error: false };
        return;
      case "hang":
        await new Promise((_, reject) => {
          ac.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return;
      case "fail":
        throw new Error(sc.message);
      case "error-result-then-throw":
        // What the real SDK does for a bad key: an error result, then the iterator throws.
        yield {
          type: "assistant",
          uuid: "a1",
          error: "authentication_failed",
          message: { content: [{ type: "text", text: sc.message }] },
        };
        yield { type: "result", subtype: "success", is_error: true, result: sc.message };
        throw new Error("Claude Code returned an error result: " + sc.message);
      case "permission": {
        const r = await options.canUseTool(
          "Bash",
          { command: sc.target },
          {
            toolUseID: "tu1",
            signal: ac.signal,
          },
        );
        if (r.behavior === "allow") {
          yield {
            type: "assistant",
            uuid: "a1",
            message: {
              content: [
                { type: "tool_use", id: "tu1", name: "Bash", input: { command: sc.target } },
              ],
            },
          };
          yield {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
          };
        } else {
          yield {
            type: "assistant",
            uuid: "a1",
            message: { content: [{ type: "text", text: r.message }] },
          };
        }
        yield { type: "result", subtype: "success", is_error: false };
        return;
      }
    }
  }
  const it = gen();
  it.interrupt = () => Promise.resolve();
  return it;
}

export async function forkSession(sessionId, options) {
  return { sessionId: `${sessionId}-fork-${options?.upToMessageId ?? "head"}` };
}
