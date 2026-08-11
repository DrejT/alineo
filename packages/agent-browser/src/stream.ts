import type { Sandbox } from "@drej/core";

/** Everything a caller needs to reach agent-browser's live-view WebSocket stream through
 * OpenSandbox's port proxy. */
export interface BrowserStreamInfo {
  /** ws(s):// URL of agent-browser's stream server, reached through OpenSandbox's port proxy
   * -- NOT directly connectable from a browser tab (see `headers`). */
  url: string;
  /** Auth headers OpenSandbox's proxy requires (e.g. `X-EXECD-ACCESS-TOKEN`). A browser's
   * native `WebSocket` constructor has no way to attach custom headers to its handshake
   * request, so a caller must relay through a server-side process that opens the upstream
   * connection itself with these headers attached -- never hand `url`+`headers` to a browser
   * tab directly. */
  headers: Record<string, string>;
  port: number;
}

interface StreamStatusJson {
  enabled: boolean;
  port: number;
  connected: boolean;
  screencasting: boolean;
}

/** `agent-browser`'s `--json` output wraps the actual payload in a `{success, data, error}`
 * envelope (confirmed live against a real sandbox -- e.g.
 * `{"success":true,"data":{"connected":false,"enabled":true,"port":45497,"screencasting":false},"error":null}`)
 * -- NOT the flat `{enabled, port, ...}` shape docs/DeepWiki implied. Both `stream status` and
 * `stream enable` share this envelope. */
function parseStreamResult(stdout: string): StreamStatusJson | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { data?: Partial<StreamStatusJson> | null };
    const data = parsed.data;
    return data && typeof data.port === "number" ? (data as StreamStatusJson) : null;
  } catch {
    return null;
  }
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

async function proxyStream(sandbox: Sandbox, port: number): Promise<BrowserStreamInfo> {
  const { url, headers } = await sandbox.proxy(port);
  return { url: toWsUrl(url), headers, port };
}

/**
 * `agent-browser`'s stream server hardcodes binding to `127.0.0.1` -- confirmed against its own
 * source, no `--host`/env override exists. That's unreachable from outside the sandbox's own
 * network namespace, which is exactly how OpenSandbox's port-proxy needs to reach it (the proxy
 * runs as a separate process connecting via the sandbox's container IP on the docker bridge
 * network, not "inside" the container). Confirmed live: connecting directly to the port from
 * inside the sandbox streams real frames perfectly; the exact same port reached through
 * OpenSandbox's proxy fails immediately with the server's own logged
 * `[Errno 111] Connection refused` -- a loopback-bind vs. proxy-reachability mismatch, not a bug
 * in agent-browser, OpenSandbox's proxy, or the JSON parsing above.
 *
 * Since agent-browser gives no way to change its bind address, this works around it with a tiny
 * dependency-free `node:net` TCP relay run inside the sandbox itself: listens on `0.0.0.0` (so
 * OpenSandbox's proxy can reach it) and forwards raw bytes to `127.0.0.1:<agent-browser's own
 * port>`. A byte-for-byte TCP forward is protocol-agnostic, so it transparently carries the
 * WebSocket traffic (handshake and all) without needing to understand it.
 */
const RELAY_SCRIPT = [
  'const net = require("node:net");',
  "const targetPort = parseInt(process.argv[2], 10);",
  "const listenPort = parseInt(process.argv[3], 10);",
  "const server = net.createServer((client) => {",
  '  const upstream = net.connect(targetPort, "127.0.0.1", () => {',
  "    client.pipe(upstream);",
  "    upstream.pipe(client);",
  "  });",
  '  upstream.on("error", () => client.destroy());',
  '  client.on("error", () => upstream.destroy());',
  "});",
  'server.listen(listenPort, "0.0.0.0", () => {',
  '  console.log("drej browser-stream relay", listenPort, "->", targetPort);',
  "});",
].join("\n");

const DEFAULT_RELAY_PORT = 19222;
const RELAY_SCRIPT_PATH = "/tmp/drej-browser-stream-relay.cjs";
const RELAY_PIDFILE = "/tmp/drej-browser-stream-relay.pid";
const RELAY_TARGETFILE = "/tmp/drej-browser-stream-relay.target";
const RELAY_LOGFILE = "/tmp/drej-browser-stream-relay.log";

/**
 * Starts the relay (see above) if it isn't already running and forwarding to `targetPort` --
 * idempotent so a second viewer joining an already-streaming session reuses the existing relay
 * instead of restarting it and dropping the first viewer's connection. Liveness is tracked via
 * a pidfile + a file recording which target port it's currently forwarding to (not just "is a
 * process running": agent-browser's own port can change across a `disable`+`enable` cycle,
 * which would otherwise leave a stale relay silently forwarding to a dead port). Detached via
 * `setsid`/`nohup`/`disown` -- without that, a background process spawned from a host-side
 * `sandbox.exec()` call doesn't survive past that one exec's own session teardown (confirmed
 * live; this is different from the agent's own long-lived Pi bridge process, where a plain `&`
 * background job survives fine across separate tool calls).
 */
async function ensureRelay(sandbox: Sandbox, targetPort: number, relayPort: number): Promise<void> {
  const check = await sandbox.exec(
    `if [ -f ${RELAY_PIDFILE} ] && [ -f ${RELAY_TARGETFILE} ] && ` +
      `[ "$(cat ${RELAY_TARGETFILE})" = "${targetPort}" ] && kill -0 "$(cat ${RELAY_PIDFILE})" 2>/dev/null; ` +
      `then echo ALIVE; else echo DEAD; fi`,
  );
  if (check.stdout.trim() === "ALIVE") return;

  await sandbox.exec(
    `[ -f ${RELAY_PIDFILE} ] && kill "$(cat ${RELAY_PIDFILE})" 2>/dev/null; sleep 0.1; true`,
  );
  await sandbox.exec(
    `cat > ${RELAY_SCRIPT_PATH} <<'DREJ_RELAY_EOF'\n${RELAY_SCRIPT}\nDREJ_RELAY_EOF`,
  );
  await sandbox.exec(
    `setsid nohup node ${RELAY_SCRIPT_PATH} ${targetPort} ${relayPort} > ${RELAY_LOGFILE} 2>&1 < /dev/null & ` +
      `RELAY_PID=$!; disown; echo -n "$RELAY_PID" > ${RELAY_PIDFILE}; echo -n "${targetPort}" > ${RELAY_TARGETFILE}; ` +
      `sleep 0.3`,
  );
}

/**
 * Starts (or reuses) agent-browser's built-in live-view WebSocket stream for the browser
 * session running inside `sandbox`, and returns a proxied URL a caller can connect to.
 *
 * Checks `agent-browser stream status --json` first and only calls `stream enable` if not
 * already active -- reuses the existing bound port across repeat calls (e.g. a second viewer
 * opening the same run's live view later) instead of leaking a growing number of listeners
 * over a long-running agent session. agent-browser's own daemon (`ensure_daemon`) starts on
 * demand, so this works even before the agent has opened a browser yet.
 *
 * Every connected viewer receives identical frames -- agent-browser's stream server broadcasts
 * to all clients (confirmed against its `StreamServer`/`frame_tx` broadcast channel), so
 * multiple callers can each get their own `BrowserStreamInfo` for the same sandbox without
 * stepping on each other.
 *
 * `stream enable` itself exits nonzero (`{"success":false,"error":"Streaming is already enabled
 * for this session"}`) when a stream is already active -- confirmed live -- rather than being
 * idempotent. The `stream status` check above is what normally avoids ever hitting that path,
 * but `@drej/core`'s `sandbox.exec()` throws `CommandError` (no stdout/stderr attached) on a
 * nonzero exit, so if `enable` is ever raced against another caller enabling it first, this
 * falls back to re-reading `status` once more before giving up, rather than surfacing a
 * misleading "command failed" error for what's actually a successful, already-streaming state.
 *
 * The returned port is a relay's port, not agent-browser's own -- see `ensureRelay()`'s doc
 * comment for why a direct proxy to agent-browser's own (loopback-only) port doesn't work.
 */
export async function enableBrowserStream(
  sandbox: Sandbox,
  opts: { port?: number; relayPort?: number } = {},
): Promise<BrowserStreamInfo> {
  const status = await sandbox.exec("agent-browser stream status --json");
  let current = parseStreamResult(status.stdout);

  if (!current?.enabled) {
    const portFlag = opts.port ? ` --port ${opts.port}` : "";
    try {
      const enabled = await sandbox.exec(`agent-browser stream enable${portFlag} --json`);
      current = parseStreamResult(enabled.stdout);
      if (!current) {
        throw new Error(
          `agent-browser stream enable did not report a bound port: ${enabled.stdout}`,
        );
      }
    } catch (err) {
      const recheck = parseStreamResult(
        (await sandbox.exec("agent-browser stream status --json")).stdout,
      );
      if (!recheck?.enabled) throw err;
      current = recheck;
    }
  }

  const relayPort = opts.relayPort ?? DEFAULT_RELAY_PORT;
  await ensureRelay(sandbox, current.port, relayPort);
  return proxyStream(sandbox, relayPort);
}

/**
 * Stops agent-browser's live-view stream for `sandbox`. Not required for normal viewer
 * teardown -- a viewer simply closing its WebSocket connection is enough, agent-browser stops
 * screencasting on its own once the last client disconnects (`client_count`-driven) -- this is
 * for explicit cleanup only (e.g. before checkpointing a sandbox that shouldn't carry a bound
 * listener port into its snapshot).
 */
export async function disableBrowserStream(sandbox: Sandbox): Promise<void> {
  await sandbox.exec("agent-browser stream disable --json");
}
