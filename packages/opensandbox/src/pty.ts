import type {
  CreatePtyOptions,
  CreatePtyResponse,
  PtyClientMessage,
  PtyServerMessage,
} from "./types";

export type PtyOutputListener = (chunk: string) => void;
export type PtyExitListener = (exitCode: number) => void;

/**
 * Wraps execd's `/pty` REST + WebSocket protocol.
 *
 * One instance per live interactive session: `create()` opens the session,
 * `connect()` opens the WebSocket and starts dispatching output/exit
 * callbacks, `write()`/`resize()`/`signal()` send input, `close()` tears
 * down the socket.
 */
export class PtyClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private ws: WebSocket | null = null;

  constructor(options: { baseUrl: string; accessToken: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
  }

  async create(opts: CreatePtyOptions = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/pty`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EXECD-ACCESS-TOKEN": this.accessToken,
      },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `execd error ${res.status}`);
    }
    const { session_id } = (await res.json()) as CreatePtyResponse;
    return session_id;
  }

  /**
   * Open the WebSocket for a session created via `create()`. Resolves once the connection is open.
   * `onExit` fires with the real exit code on a normal `{"type":"exit"}` frame, or with `-1` if
   * the socket closes for any other reason (network drop, container restart, etc.) — callers
   * should not treat `-1` as a real process exit code.
   */
  connect(sessionId: string, onOutput: PtyOutputListener, onExit: PtyExitListener): Promise<void> {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}/pty/${sessionId}/ws?token=${encodeURIComponent(this.accessToken)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const decoder = new TextDecoder();
    let gotExitFrame = false;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve();
      };
      ws.onerror = (ev) => {
        reject(new Error(`pty websocket error: ${ev.type}`));
      };
      ws.onclose = () => {
        if (!gotExitFrame) onExit(-1);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data) as PtyServerMessage;
          if (msg.type === "exit") {
            gotExitFrame = true;
            onExit(msg.exit_code);
          }
          return;
        }
        // First byte is a channel marker (stdout/stderr in pipe mode, multiplexed in PTY mode).
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        onOutput(decoder.decode(bytes.slice(1)));
      };
    });
  }

  write(data: string): void {
    this.ws?.send(JSON.stringify({ type: "stdin", data } satisfies PtyClientMessage));
  }

  resize(cols: number, rows: number): void {
    this.ws?.send(JSON.stringify({ type: "resize", cols, rows } satisfies PtyClientMessage));
  }

  signal(name: string): void {
    this.ws?.send(JSON.stringify({ type: "signal", signal: name } satisfies PtyClientMessage));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
