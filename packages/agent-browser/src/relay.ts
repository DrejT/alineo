/**
 * Relay a live view between a person's browser tab and agent-browser's stream in a sandbox.
 *
 * The sandbox's port proxy needs auth headers, and a browser's `WebSocket` cannot send
 * headers. So a server opens the upstream connection with the headers and relays messages
 * to and from the tab. The headers never leave the server.
 *
 * Only what a viewer needs passes:
 * - to the tab: `frame`, `status` and `url` messages (not `console` or `tabs`, which can
 *   carry page data the person does not see on screen);
 * - to the browser: `input_mouse`, `input_keyboard`, `input_touch`, `config` and `ack`.
 */
import type { BrowserStreamInfo } from "./stream";

/** The tab side of the relay: anything with `send` and `close`, such as a server WebSocket. */
export interface RelayDownstream {
  send(message: string): unknown;
  close(code?: number, reason?: string): unknown;
}

/** The upstream socket the relay needs. Bun's global `WebSocket` fits. */
export interface RelayUpstream {
  send(message: string): void;
  close(): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", fn: () => void): void;
}

export interface RelayOptions {
  /**
   * Open the upstream socket with `headers`. The default uses the global `WebSocket` with a
   * `headers` option, which Bun supports. On another runtime, pass a `ws` client here.
   */
  connect?: (url: string, headers: Record<string, string>) => RelayUpstream;
  /** Frame rate cap sent upstream on connect. Default 10. */
  maxFps?: number;
}

export interface BrowserStreamRelay {
  /** Pass one message from the tab. Messages of other types are dropped. */
  fromViewer(message: string | Uint8Array): void;
  /** Close both sides. Safe to call more than once. */
  close(): void;
}

const TO_VIEWER = new Set(["frame", "status", "url"]);
const TO_BROWSER = new Set(["input_mouse", "input_keyboard", "input_touch", "config", "ack"]);

function messageType(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      const t = parsed.type;
      return typeof t === "string" ? t : undefined;
    }
  } catch {
    // Not JSON: drop it.
  }
  return undefined;
}

type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => RelayUpstream;

function isConstructor(v: unknown): v is BunWebSocketConstructor {
  return typeof v === "function";
}

function defaultConnect(url: string, headers: Record<string, string>): RelayUpstream {
  // Bun's WebSocket takes `{ headers }`, but the DOM constructor type hides that overload.
  // Node's global WebSocket ignores `headers`: pass `connect` there.
  const ctor: unknown = globalThis.WebSocket;
  if (!isConstructor(ctor))
    throw new Error("relayBrowserStream: no global WebSocket, pass `connect`");
  return new ctor(url, { headers });
}

/** Start relaying `stream` to `viewer`. Call `fromViewer` for each message the tab sends. */
export function relayBrowserStream(
  stream: BrowserStreamInfo,
  viewer: RelayDownstream,
  opts: RelayOptions = {},
): BrowserStreamRelay {
  const upstream = (opts.connect ?? defaultConnect)(
    `${stream.url}${stream.url.includes("?") ? "&" : "?"}maxFps=${String(opts.maxFps ?? 10)}`,
    stream.headers,
  );
  let closed = false;
  let open = false;
  const pending: string[] = [];

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      upstream.close();
    } catch {
      // Already closed.
    }
    try {
      viewer.close();
    } catch {
      // Already closed.
    }
  };

  upstream.addEventListener("open", () => {
    open = true;
    for (const m of pending.splice(0)) upstream.send(m);
  });
  upstream.addEventListener("message", (e) => {
    const text = typeof e.data === "string" ? e.data : undefined;
    if (text === undefined || closed) return;
    const t = messageType(text);
    if (t !== undefined && TO_VIEWER.has(t)) viewer.send(text);
  });
  upstream.addEventListener("close", close);
  upstream.addEventListener("error", close);

  return {
    fromViewer(message) {
      if (closed) return;
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const t = messageType(text);
      if (t === undefined || !TO_BROWSER.has(t)) return;
      if (open) upstream.send(text);
      else pending.push(text);
    },
    close,
  };
}
