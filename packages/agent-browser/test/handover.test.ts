import { describe, expect, test } from "bun:test";
import {
  browser,
  handover,
  relayBrowserStream,
  type BrowserStreamInfo,
  type RelayUpstream,
  type StreamSandbox,
} from "../src/index";

type Op =
  | { kind: "exec"; cmd: string; opts?: { name?: string; timeoutMs?: number } }
  | { kind: "host"; name: string; fn: (s: StreamSandbox) => void | Promise<void> };

function recorder() {
  const ops: Op[] = [];
  return {
    ops,
    exec(cmd: string, opts?: { name?: string; timeoutMs?: number }) {
      ops.push({ kind: "exec", cmd, opts });
    },
    host(name: string, fn: (s: StreamSandbox) => void | Promise<void>) {
      ops.push({ kind: "host", name, fn });
    },
  };
}

/** A sandbox whose agent-browser reports a stream on port 4100 and records every command. */
function fakeSandbox() {
  const cmds: string[] = [];
  const fake = {
    exec(cmd: string) {
      cmds.push(cmd);
      const stdout = cmd.includes("stream status")
        ? JSON.stringify({ success: true, data: { enabled: true, port: 4100 } })
        : cmd.includes("cat /tmp/alineo-browser-stream-relay.target")
          ? "ALIVE"
          : "";
      return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
    },
    proxy(port: number) {
      return Promise.resolve({
        url: `http://proxy.local/p/${String(port)}`,
        headers: { "X-Token": "t" },
      });
    },
  };
  // The fake returns a plain promise where the real exec returns an ExecHandle.
  const sandbox: StreamSandbox = fake as never;
  return { sandbox, cmds };
}

describe("handover", () => {
  test("queues live view, wait, end live view, with the wait timeout and a margin", () => {
    const sb = recorder();
    const b = browser({ session: "co" });
    handover(sb, b, {
      name: "captcha",
      until: { url: "**/account/**" },
      timeoutMs: 600_000,
      onLive: () => undefined,
      session: "co",
    });
    expect(sb.ops.map((o) => (o.kind === "host" ? o.name : o.opts?.name))).toEqual([
      "captcha: live view",
      "captcha: wait",
      "captcha: end live view",
    ]);
    const wait = sb.ops[1] as Extract<Op, { kind: "exec" }>;
    expect(wait.cmd).toBe(b.waitForUrl("**/account/**", { timeoutMs: 600_000 }));
    expect(wait.opts?.timeoutMs).toBe(630_000);
  });

  test("waits on a selector or text when asked", () => {
    const b = browser();
    for (const [until, expected] of [
      [{ selector: "#done" }, b.waitForSelector("#done", { timeoutMs: 1000 })],
      [{ text: "Welcome" }, b.waitForText("Welcome", { timeoutMs: 1000 })],
    ] as const) {
      const sb = recorder();
      handover(sb, b, { until, timeoutMs: 1000, onLive: () => undefined });
      expect((sb.ops[1] as Extract<Op, { kind: "exec" }>).cmd).toBe(expected);
    }
  });

  test("the host steps give the stream to onLive and stop it for the same session", async () => {
    const sb = recorder();
    let live: BrowserStreamInfo | undefined;
    let ended = false;
    handover(sb, browser({ session: "co" }), {
      until: { url: "**/x" },
      timeoutMs: 1000,
      onLive: (s) => {
        live = s;
      },
      onEnd: () => {
        ended = true;
      },
      session: "co",
    });
    const { sandbox, cmds } = fakeSandbox();
    await (sb.ops[0] as Extract<Op, { kind: "host" }>).fn(sandbox);
    expect(live?.url).toStartWith("ws://proxy.local/p/");
    expect(live?.headers).toEqual({ "X-Token": "t" });
    await (sb.ops[2] as Extract<Op, { kind: "host" }>).fn(sandbox);
    expect(ended).toBe(true);
    expect(cmds[0]).toBe("agent-browser --session 'co' stream status --json");
    expect(cmds.at(-1)).toBe("agent-browser --session 'co' stream disable --json");
  });
});

function fakeUpstream() {
  const sent: string[] = [];
  const listeners: Record<string, Array<(e: { data: unknown }) => void>> = {};
  let closed = false;
  const upstream: RelayUpstream = {
    send: (m) => sent.push(m),
    close: () => {
      closed = true;
    },
    addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const fire = (type: string, data?: unknown) => {
    for (const fn of listeners[type] ?? []) fn({ data });
  };
  return { upstream, sent, fire, isClosed: () => closed };
}

describe("relayBrowserStream", () => {
  const stream: BrowserStreamInfo = { url: "ws://proxy/p/1", headers: { "X-Token": "t" }, port: 1 };

  test("opens upstream with the headers, and passes only viewer message types", () => {
    const up = fakeUpstream();
    let opened: { url: string; headers: Record<string, string> } | undefined;
    const toViewer: string[] = [];
    const relay = relayBrowserStream(
      stream,
      { send: (m) => toViewer.push(m), close: () => undefined },
      {
        connect: (url, headers) => {
          opened = { url, headers };
          return up.upstream;
        },
      },
    );
    expect(opened).toEqual({ url: "ws://proxy/p/1?maxFps=10", headers: { "X-Token": "t" } });

    for (const type of ["frame", "status", "url", "console", "tabs"]) {
      up.fire("message", JSON.stringify({ type }));
    }
    up.fire("message", "not json");
    expect(toViewer.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
      "frame",
      "status",
      "url",
    ]);

    // Input sent before the socket opens is held, then flushed in order.
    relay.fromViewer(JSON.stringify({ type: "input_mouse", x: 1 }));
    relay.fromViewer(JSON.stringify({ type: "command", action: "eval" }));
    expect(up.sent).toEqual([]);
    up.fire("open");
    relay.fromViewer(JSON.stringify({ type: "input_keyboard", key: "a" }));
    expect(up.sent.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
      "input_mouse",
      "input_keyboard",
    ]);
  });

  test("closing either side closes both", () => {
    const up = fakeUpstream();
    let viewerClosed = false;
    relayBrowserStream(
      stream,
      {
        send: () => undefined,
        close: () => {
          viewerClosed = true;
        },
      },
      { connect: () => up.upstream },
    );
    up.fire("close");
    expect(viewerClosed).toBe(true);

    const up2 = fakeUpstream();
    const relay = relayBrowserStream(
      stream,
      { send: () => undefined, close: () => undefined },
      { connect: () => up2.upstream },
    );
    relay.close();
    relay.close();
    expect(up2.isClosed()).toBe(true);
  });
});
