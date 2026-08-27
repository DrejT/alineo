import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PtyClient } from "../src/pty.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "";
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Simulate the server dropping the connection (network blip, container restart, etc). */
  triggerAbruptClose(): void {
    this.onclose?.();
  }
}

function binaryFrame(channel: number, text: string): ArrayBuffer {
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = channel;
  bytes.set(body, 1);
  return bytes.buffer;
}

async function connectFakeSocket(client: PtyClient, sessionId = "session-1") {
  const onOutput = vi.fn();
  const onExit = vi.fn();
  const connectPromise = client.connect(sessionId, onOutput, onExit);
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("expected a FakeWebSocket instance");
  ws.triggerOpen();
  await connectPromise;
  return { ws, onOutput, onExit };
}

describe("PtyClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create() posts to /pty and returns the session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: "abc-123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const sessionId = await client.create({ cwd: "/root" });

    expect(sessionId).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/pty",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-EXECD-ACCESS-TOKEN": "tok" }) as unknown,
        body: JSON.stringify({ cwd: "/root" }),
      }),
    );
  });

  it("create() throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    await expect(client.create()).rejects.toThrow("boom");
  });

  it("connect() opens a WebSocket at /pty/:sessionId/ws with the token in the query string", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws } = await connectFakeSocket(client, "session-1");
    expect(ws.url).toBe("ws://localhost:8080/pty/session-1/ws?token=tok");
  });

  it("write() sends a stdin JSON frame", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws } = await connectFakeSocket(client);
    client.write("whoami\n");
    expect(ws.sent).toContain(JSON.stringify({ type: "stdin", data: "whoami\n" }));
  });

  it("resize() sends a resize JSON frame", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws } = await connectFakeSocket(client);
    client.resize(80, 24);
    expect(ws.sent).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  });

  it("signal() sends a signal JSON frame", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws } = await connectFakeSocket(client);
    client.signal("SIGINT");
    expect(ws.sent).toContain(JSON.stringify({ type: "signal", signal: "SIGINT" }));
  });

  it("close() closes the underlying WebSocket", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws } = await connectFakeSocket(client);
    client.close();
    expect(ws.closed).toBe(true);
  });

  it("a binary frame fires onOutput with the channel byte stripped", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws, onOutput } = await connectFakeSocket(client);
    ws.triggerMessage(binaryFrame(0x01, "hello\n"));
    expect(onOutput).toHaveBeenCalledWith("hello\n");
  });

  it('a {"type":"exit","exit_code":N} JSON frame fires onExit with the exit code', async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws, onExit } = await connectFakeSocket(client);
    ws.triggerMessage(JSON.stringify({ type: "exit", exit_code: 3 }));
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it('a {"type":"connected"} frame is ignored without crashing', async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws, onExit, onOutput } = await connectFakeSocket(client);
    expect(() => {
      ws.triggerMessage(JSON.stringify({ type: "connected", session_id: "s1", mode: "pty" }));
    }).not.toThrow();
    expect(onExit).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("an abrupt close without an exit frame fires onExit with -1", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws, onExit } = await connectFakeSocket(client);
    ws.triggerAbruptClose();
    expect(onExit).toHaveBeenCalledWith(-1);
  });

  it("a clean exit frame followed by close does not double-fire onExit", async () => {
    const client = new PtyClient({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    const { ws, onExit } = await connectFakeSocket(client);
    ws.triggerMessage(JSON.stringify({ type: "exit", exit_code: 0 }));
    ws.triggerAbruptClose();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});
