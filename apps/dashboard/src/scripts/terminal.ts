/** Ported from apps/sandbox/src/scripts/terminal.ts — same xterm+WS bridge, pointed at
 *  the dashboard server's `/sandboxes/:id/exec` WS instead of the playground's own server. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { openSocket } from "../lib/api";

export interface TerminalHandle {
  fit(): void;
  dispose(): void;
}

export function mountTerminal(container: HTMLElement, sandboxId: string): TerminalHandle {
  const term = new Terminal({
    convertEol: true,
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    theme: { background: "#111111" },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let ws: WebSocket | null = null;
  let disposed = false;

  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  openSocket(`/sandboxes/${sandboxId}/exec`)
    .then((socket) => {
      if (disposed) return socket.close();
      ws = socket;
      socket.addEventListener("open", () => {
        fitAddon.fit();
        sendResize();
      });
      socket.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") term.write(ev.data);
      });
      socket.addEventListener("close", () => {
        term.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n");
      });
    })
    .catch((err) => term.write(`\r\n\x1b[31m[${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`));

  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  });

  return {
    fit() {
      fitAddon.fit();
      sendResize();
    },
    dispose() {
      disposed = true;
      ws?.close();
      term.dispose();
    },
  };
}
