import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type CliRenderer,
} from "@opentui/core";
import type { Alineo } from "alineo";

export interface ChatView {
  box: BoxRenderable;
  dispose(): void;
}

/**
 * Renders a subset of the `AgentEvent` vocabulary (text, tool_start, tool_end,
 * extension_error) that the web dashboard's `agentChat.ts` also handles, into a
 * scrollbox instead of the DOM — other event types are currently ignored.
 * Pressing Escape returns to the dashboard without calling `agent.close()` —
 * the sandbox and Pi session keep running, same detach semantics as the
 * `spawn`/`prompt` commands.
 */
export function createChatView(renderer: CliRenderer, agent: Alineo, onBack: () => void): ChatView {
  const box = new BoxRenderable(renderer, {
    id: "chat",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
  });

  box.add(
    new TextRenderable(renderer, {
      id: "chat-title",
      content: `${agent.name}  (${agent.sandboxId})   — esc: back to dashboard (session keeps running)`,
    }),
  );

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "chat-scroll",
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
  });
  box.add(scroll);

  let lineCounter = 0;
  function appendLine(content: string): TextRenderable {
    const text = new TextRenderable(renderer, { id: `chat-line-${lineCounter++}`, content });
    scroll.add(text);
    return text;
  }

  const input = new InputRenderable(renderer, {
    id: "chat-input",
    width: "100%",
    placeholder: "Type a prompt and press enter...",
  });
  box.add(input);

  let busy = false;

  async function send(message: string): Promise<void> {
    if (busy) return;
    busy = true;
    appendLine(`> ${message}`);

    let assistant: TextRenderable | null = null;
    let assistantText = "";
    try {
      for await (const ev of agent.prompt(message)) {
        switch (ev.type) {
          case "text":
            assistantText += ev.text;
            if (assistant) assistant.content = assistantText;
            else assistant = appendLine(assistantText);
            break;
          case "tool_start":
            appendLine(`[tool] ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 160)}`);
            break;
          case "tool_end":
            appendLine(`[tool] ${ev.toolName} ${ev.isError ? "failed" : "done"}`);
            break;
          case "extension_error":
            appendLine(`[extension error] ${ev.extensionPath}: ${ev.error}`);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
    }
    busy = false;
  }

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    const trimmed = value.trim();
    input.value = "";
    if (trimmed) void send(trimmed);
  });
  input.focus();

  const onKeypress = (event: { name: string }) => {
    if (event.name === "escape") onBack();
  };
  renderer.keyInput.on("keypress", onKeypress);

  return {
    box,
    dispose() {
      renderer.keyInput.off("keypress", onKeypress);
      input.blur();
    },
  };
}
