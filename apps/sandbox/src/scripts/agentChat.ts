import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentEvent, PiModel, PiSessionState, SessionStats, ThinkingLevel } from "alineo";
import { api, wsUrl, type ForkPoint } from "./api";

type BridgeErrorEvent = { type: "bridge_error"; message: string };
type CommandResultEvent = { type: "command_result"; command: string; result: unknown };
type ChatEvent = AgentEvent | BridgeErrorEvent | CommandResultEvent;

const THINKING_LEVELS: ThinkingLevel[] = ["none", "low", "medium", "high"];

marked.setOptions({ breaks: true });

function renderMarkdown(raw: string): string {
  return DOMPurify.sanitize(marked.parse(raw, { async: false }) as string);
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

interface ToolCallEntry {
  details: HTMLDetailsElement;
  summary: HTMLElement;
  argsEl: HTMLElement;
  resultEl: HTMLElement;
  toolName: string;
}

/** Menu-item style shared by the model/thinking/fork popover lists — plain rows, not buttons. */
const MENU_ITEM_CLASS = "w-full rounded px-2 py-1 text-left hover:bg-[var(--color-bg)]";

export function mountAgentChat(agentId: string): { dispose(): void } {
  const messages = document.getElementById("chat-messages") as HTMLDivElement;
  const form = document.getElementById("chat-form") as HTMLFormElement;
  const input = document.getElementById("chat-input") as HTMLInputElement;
  const steerBtn = document.getElementById("chat-steer-btn") as HTMLButtonElement;
  const abortBtn = document.getElementById("chat-abort-btn") as HTMLButtonElement;
  const queueBadge = document.getElementById("chat-queue-badge") as HTMLSpanElement | null;

  const statModel = document.getElementById("stat-model") as HTMLSpanElement;
  const statThinking = document.getElementById("stat-thinking") as HTMLSpanElement;
  const statContext = document.getElementById("stat-context") as HTMLSpanElement;
  const statCost = document.getElementById("stat-cost") as HTMLSpanElement;

  const modelPopover = document.getElementById("model-popover") as HTMLDetailsElement;
  const modelList = document.getElementById("model-list") as HTMLDivElement;
  const thinkingPopover = document.getElementById("thinking-popover") as HTMLDetailsElement;
  const thinkingList = document.getElementById("thinking-list") as HTMLDivElement;
  const contextPopover = document.getElementById("context-popover") as HTMLDetailsElement;
  const autoCompactionToggle = document.getElementById(
    "auto-compaction-toggle",
  ) as HTMLInputElement;
  const compactNowBtn = document.getElementById("compact-now-btn") as HTMLButtonElement;

  const sessionMenu = document.getElementById("session-menu") as HTMLDetailsElement;
  const sessionNewBtn = document.getElementById("session-new-btn") as HTMLButtonElement;
  const sessionCloneBtn = document.getElementById("session-clone-btn") as HTMLButtonElement;
  const sessionExportBtn = document.getElementById("session-export-btn") as HTMLButtonElement;
  const sessionRenameForm = document.getElementById("session-rename-form") as HTMLFormElement;
  const sessionRenameInput = document.getElementById("session-rename-input") as HTMLInputElement;
  const sessionSwitchForm = document.getElementById("session-switch-form") as HTMLFormElement;
  const sessionSwitchInput = document.getElementById("session-switch-input") as HTMLInputElement;
  const forkSubmenu = document.getElementById("fork-submenu") as HTMLDetailsElement;
  const forkList = document.getElementById("fork-list") as HTMLDivElement;
  const autoRetryToggle = document.getElementById("auto-retry-toggle") as HTMLInputElement;

  let streaming = false;
  let assistantBubble: HTMLDivElement | null = null;
  let assistantRawText = "";
  let renderScheduled = false;
  const toolCalls = new Map<string, ToolCallEntry>();
  const permissionCards = new Map<string, HTMLElement>();

  function send(cmd: Record<string, unknown> & { type: string }) {
    ws.send(JSON.stringify(cmd));
  }

  function setStreaming(value: boolean) {
    streaming = value;
    steerBtn.disabled = !streaming;
    abortBtn.disabled = !streaming;
    assistantBubble = null;
    assistantRawText = "";
  }

  function scrollToBottomIfNear(wasNearBottom: boolean) {
    if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
  }

  function addBubble(role: "you" | "agent" | "error" | "system", text: string): HTMLDivElement {
    const wasNearBottom = isNearBottom(messages);
    const bubble = document.createElement("div");
    bubble.className =
      role === "you"
        ? "self-end rounded-lg bg-[var(--color-accent)] px-3 py-2 text-white"
        : role === "error"
          ? "rounded-lg border border-[var(--color-danger)] px-3 py-2 text-[var(--color-danger)]"
          : role === "system"
            ? "mono pl-1 text-xs text-[var(--color-muted)] italic"
            : "prose prose-sm max-w-none rounded-lg border border-[var(--color-border)] px-3 py-2";
    bubble.textContent = text;
    messages.appendChild(bubble);
    scrollToBottomIfNear(wasNearBottom);
    return bubble;
  }

  /** Same as a "system" bubble, but with an inline action link (used for the retry-cancel affordance). */
  function addSystemNoteWithAction(text: string, actionLabel: string, onAction: () => void) {
    const wasNearBottom = isNearBottom(messages);
    const bubble = document.createElement("div");
    bubble.className = "mono pl-1 text-xs text-[var(--color-muted)] italic";
    bubble.textContent = `${text} `;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "not-italic underline hover:text-[var(--color-fg)]";
    action.textContent = actionLabel;
    action.addEventListener("click", () => {
      onAction();
      action.disabled = true;
      action.className = "not-italic underline opacity-40";
    });
    bubble.appendChild(action);
    messages.appendChild(bubble);
    scrollToBottomIfNear(wasNearBottom);
  }

  function addCopyButtons(container: HTMLElement) {
    for (const pre of container.querySelectorAll("pre")) {
      if (pre.querySelector("[data-copy-btn]")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.copyBtn = "";
      btn.className =
        "absolute top-1 right-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[0.65rem] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        void navigator.clipboard.writeText(code).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        });
      });
      pre.classList.add("relative");
      pre.appendChild(btn);
    }
  }

  function scheduleAssistantRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!assistantBubble) return;
      const wasNearBottom = isNearBottom(messages);
      assistantBubble.innerHTML = renderMarkdown(assistantRawText);
      addCopyButtons(assistantBubble);
      scrollToBottomIfNear(wasNearBottom);
    });
  }

  function appendText(text: string) {
    if (!assistantBubble) {
      assistantBubble = document.createElement("div");
      assistantBubble.className =
        "prose prose-sm max-w-none rounded-lg border border-[var(--color-border)] px-3 py-2";
      messages.appendChild(assistantBubble);
      assistantRawText = "";
    }
    assistantRawText += text;
    scheduleAssistantRender();
  }

  function ensureToolCall(toolCallId: string, toolName: string, args: unknown): ToolCallEntry {
    let entry = toolCalls.get(toolCallId);
    if (entry) return entry;

    const wasNearBottom = isNearBottom(messages);
    const details = document.createElement("details");
    details.className = "rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs";
    const summary = document.createElement("summary");
    summary.className = "mono list-none cursor-pointer text-[var(--color-muted)]";
    summary.textContent = `▶ ${toolName}`;
    const argsEl = document.createElement("pre");
    argsEl.className =
      "mono mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-all text-[var(--color-muted)]";
    argsEl.textContent = JSON.stringify(args, null, 2);
    const resultEl = document.createElement("pre");
    resultEl.className =
      "mono mt-2 hidden max-h-[260px] overflow-auto whitespace-pre-wrap break-all text-[var(--color-muted)]";
    details.append(summary, argsEl, resultEl);
    messages.appendChild(details);
    scrollToBottomIfNear(wasNearBottom);

    entry = { details, summary, argsEl, resultEl, toolName };
    toolCalls.set(toolCallId, entry);
    return entry;
  }

  function renderPermissionCard(requestId: string, tool: string, target: string, title: string) {
    if (permissionCards.has(requestId)) return;
    const wasNearBottom = isNearBottom(messages);

    const card = document.createElement("div");
    card.className =
      "rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] px-3 py-2 text-xs";

    const heading = document.createElement("p");
    heading.className = "mb-1 font-semibold text-[var(--color-fg)]";
    heading.textContent = `Approval needed — ${tool}`;

    const cmd = document.createElement("pre");
    cmd.className =
      "mono mt-1 mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[var(--color-muted)]";
    cmd.textContent = target || title;

    const actions = document.createElement("div");
    actions.className = "flex flex-wrap gap-1";

    const resolve = (decision: Record<string, unknown>) => {
      send({ type: "resolvePermission", requestId, decision });
    };
    const mkBtn = (label: string, onClick: () => void, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "btn btn-primary" : "btn";
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };

    actions.append(
      mkBtn("Allow once", () => resolve({ kind: "once" }), true),
      mkBtn("Always allow", () => resolve({ kind: "always" })),
      mkBtn("Deny", () => resolve({ kind: "reject" })),
      mkBtn("Deny with feedback…", () => {
        const feedback = window.prompt("Tell the agent what to do instead:") ?? "";
        resolve({ kind: "reject", feedback });
      }),
    );

    card.append(heading, cmd, actions);
    messages.appendChild(card);
    permissionCards.set(requestId, card);
    scrollToBottomIfNear(wasNearBottom);
  }

  function settlePermissionCard(requestId: string, label: string) {
    const card = permissionCards.get(requestId);
    if (!card) return;
    permissionCards.delete(requestId);
    card.className = "mono pl-1 text-xs text-[var(--color-muted)] italic";
    card.textContent = label;
  }

  function setQueueBadge(steering: number, followUp: number) {
    if (!queueBadge) return;
    const total = steering + followUp;
    queueBadge.textContent = total > 0 ? `${total} queued` : "";
  }

  // --- status bar ---

  function renderState(state: PiSessionState) {
    statModel.textContent = `model ${state.model?.id ?? "—"}`;
    statThinking.textContent = `thinking ${state.thinkingLevel}`;
    autoCompactionToggle.checked = state.autoCompactionEnabled;
  }

  function renderStats(stats: SessionStats) {
    const pct = stats.contextUsage ? `${Math.round(stats.contextUsage.percent)}%` : "—";
    statContext.textContent = `ctx ${pct}`;
    statCost.textContent = formatCost(stats.cost);
  }

  async function refreshStatus() {
    try {
      const [state, stats] = await Promise.all([
        api.getAgentState(agentId),
        api.getAgentStats(agentId),
      ]);
      renderState(state);
      renderStats(stats);
    } catch {
      // Best-effort — the status bar just stays at its last known values.
    }
  }

  function renderModelList(models: PiModel[]) {
    modelList.replaceChildren();
    for (const model of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = MENU_ITEM_CLASS;
      item.textContent = model.id;
      item.addEventListener("click", () => {
        send({ type: "setModel", provider: model.api, modelId: model.id });
        modelPopover.open = false;
      });
      modelList.appendChild(item);
    }
  }

  function renderThinkingList() {
    thinkingList.replaceChildren();
    for (const level of THINKING_LEVELS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = MENU_ITEM_CLASS;
      item.textContent = level;
      item.addEventListener("click", () => {
        send({ type: "setThinkingLevel", level });
        thinkingPopover.open = false;
      });
      thinkingList.appendChild(item);
    }
  }

  function renderForkList(forkPoints: ForkPoint[]) {
    forkList.replaceChildren();
    if (forkPoints.length === 0) {
      const empty = document.createElement("p");
      empty.className = "px-2 py-1 text-[var(--color-muted)]";
      empty.textContent = "No fork points yet.";
      forkList.appendChild(empty);
      return;
    }
    for (const point of forkPoints) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `${MENU_ITEM_CLASS} truncate`;
      item.title = point.text;
      item.textContent = point.text.slice(0, 60) || point.entryId;
      item.addEventListener("click", () => {
        send({ type: "fork", entryId: point.entryId });
        sessionMenu.open = false;
      });
      forkList.appendChild(item);
    }
  }

  modelPopover.addEventListener("toggle", () => {
    if (!modelPopover.open) return;
    void api.getAgentModels(agentId).then((r) => renderModelList(r.models));
  });
  thinkingPopover.addEventListener("toggle", () => {
    if (thinkingPopover.open) renderThinkingList();
  });
  forkSubmenu.addEventListener("toggle", () => {
    if (!forkSubmenu.open) return;
    void api.getAgentForkPoints(agentId).then((r) => renderForkList(r.forkPoints));
  });

  autoCompactionToggle.addEventListener("change", () => {
    send({ type: "setAutoCompaction", enabled: autoCompactionToggle.checked });
  });
  compactNowBtn.addEventListener("click", () => {
    send({ type: "compact" });
    contextPopover.open = false;
  });
  autoRetryToggle.addEventListener("change", () => {
    send({ type: "setAutoRetry", enabled: autoRetryToggle.checked });
  });

  sessionNewBtn.addEventListener("click", () => {
    send({ type: "newSession" });
    sessionMenu.open = false;
  });
  sessionCloneBtn.addEventListener("click", () => {
    send({ type: "clone" });
    sessionMenu.open = false;
  });
  sessionExportBtn.addEventListener("click", () => {
    send({ type: "exportHtml" });
  });
  sessionRenameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = sessionRenameInput.value.trim();
    if (!name) return;
    send({ type: "setSessionName", name });
    sessionRenameInput.value = "";
    sessionMenu.open = false;
  });
  sessionSwitchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const path = sessionSwitchInput.value.trim();
    if (!path) return;
    send({ type: "switchSession", path });
    sessionSwitchInput.value = "";
    sessionMenu.open = false;
  });

  const ws = new WebSocket(wsUrl(`/ws/agents/${agentId}/chat`));

  ws.addEventListener("open", () => {
    void refreshStatus();
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const event = JSON.parse(ev.data) as ChatEvent;

    switch (event.type) {
      case "agent_start": {
        setStreaming(true);
        break;
      }
      case "agent_end": {
        setStreaming(false);
        void refreshStatus();
        break;
      }
      case "text": {
        appendText(event.text);
        break;
      }
      case "tool_start": {
        ensureToolCall(event.toolCallId, event.toolName, event.args);
        break;
      }
      case "tool_update": {
        const entry = ensureToolCall(event.toolCallId, event.toolName, {});
        entry.resultEl.classList.remove("hidden");
        entry.resultEl.textContent = `--- partial ---\n${JSON.stringify(event.partialResult, null, 2)}`;
        break;
      }
      case "tool_end": {
        const entry = ensureToolCall(event.toolCallId, event.toolName, {});
        entry.summary.textContent = `${event.isError ? "✗" : "✓"} ${entry.toolName}`;
        entry.resultEl.classList.remove("hidden");
        entry.resultEl.textContent = `--- result ---\n${JSON.stringify(event.result, null, 2)}`;
        break;
      }
      case "auto_retry_start": {
        addSystemNoteWithAction(
          `Retrying (attempt ${event.attempt}/${event.maxAttempts})… ${event.errorMessage}`,
          "Cancel",
          () => send({ type: "abortRetry" }),
        );
        break;
      }
      case "auto_retry_end": {
        addBubble(
          "system",
          event.success
            ? "Retry succeeded"
            : `Retry failed: ${event.finalError ?? "unknown error"}`,
        );
        break;
      }
      case "compaction_start": {
        addBubble("system", "Compacting context…");
        break;
      }
      case "compaction_end": {
        if (!event.aborted && event.result) {
          addBubble(
            "system",
            `Context compacted (${event.result.tokensBefore} → ${event.result.estimatedTokensAfter} tokens)`,
          );
        }
        void refreshStatus();
        break;
      }
      case "extension_error": {
        addBubble("error", `Extension error (${event.extensionPath}): ${event.error}`);
        break;
      }
      case "extension_ui": {
        if (event.isDialog) {
          addBubble("system", `Alineo requested UI (${event.method}), auto-dismissed`);
        }
        break;
      }
      case "permission_request": {
        renderPermissionCard(event.requestId, event.tool, event.target, event.title);
        break;
      }
      case "permission_resolved": {
        const kind = event.decision.kind;
        settlePermissionCard(
          event.requestId,
          kind === "reject" ? "Tool call denied" : "Tool call approved",
        );
        break;
      }
      case "queue_update": {
        setQueueBadge(event.steering.length, event.followUp.length);
        break;
      }
      case "command_result": {
        if (event.command === "exportHtml" && event.result) {
          const { path } = event.result as { path: string };
          window.open(api.agentExportUrl(agentId, path), "_blank");
        }
        void refreshStatus();
        break;
      }
      case "bridge_error": {
        addBubble("error", event.message);
        setStreaming(false);
        break;
      }
      default:
        break;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addBubble("you", text);
    send({ type: streaming ? "followUp" : "prompt", text });
    input.value = "";
    if (!streaming) setStreaming(true);
  });

  steerBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    addBubble("you", `(steer) ${text}`);
    send({ type: "steer", text });
    input.value = "";
  });

  abortBtn.addEventListener("click", () => {
    send({ type: "abort" });
  });

  return {
    dispose() {
      ws.close();
    },
  };
}
