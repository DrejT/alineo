/**
 * The in-sandbox bridge: wraps `pi --mode rpc` in an HTTP server so the host can talk to it
 * without interactive stdin from the sandbox exec API.
 *
 * Bundled to one CommonJS file (`dist/pi-bridge.cjs`) and written into the sandbox at
 * `/alineo-bridge.js`, where it runs with plain `node`. Import only Node built-ins and
 * `type`s from `./wire.ts`: nothing else exists in the sandbox.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createInterface, type Interface } from "node:readline";
import type { BridgePermissionEvent, BridgeRequestBody, PiLine } from "./wire.ts";

// Paths/port are fixed in the sandbox; the env overrides exist only so the bridge can be
// driven against a stub `pi` in unit tests (test/pi-bridge.test.ts).
const PORT = Number(process.env.ALINEO_BRIDGE_PORT) || 3001;
const ENV_FILE = process.env.ALINEO_ENV_FILE || "/etc/alineo-env";
const PI_CONFIG_FILE = process.env.ALINEO_PI_CONFIG || "/etc/alineo-pi.json";
const PI_BIN = process.env.ALINEO_PI_BIN || "pi";

type Timer = ReturnType<typeof setTimeout>;

/** An item the host asked for: the in-flight prompt, or a queued one. */
interface PromptItem {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  res: ServerResponse;
  text: string;
  t0: number;
  heartbeat?: Timer;
}

/** A command waiting for Pi's response ack. */
interface PendingCmd {
  res: ServerResponse;
  timer?: Timer;
  bash?: boolean;
  heartbeat?: Timer;
}

/** A permission-gate dialog Pi is blocked on. */
interface PendingPermission {
  tool: string;
  target: string;
  title: string;
  since: number;
  timer: Timer | null;
}

// Re-read /etc/alineo-env into process.env on each Pi (re)start so setEnv() changes take effect.
function loadEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/);
    if (m) process.env[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

// Build the pi CLI args from /etc/alineo-pi.json (model/provider config, written by the host).
// Supports: provider, model, resume (--continue to resume the most recent session),
// permissions (loads the alineo permission-gate extension by explicit path).
// `POLICY_ACTIVE` gates the permission-request routing below and is set here, before Pi
// is ever spawned, so there is no window where Pi could emit a gate dialog first.
let POLICY_ACTIVE = false;
const PERMISSION_GATE_PATH =
  process.env.ALINEO_PERMISSION_GATE_PATH || "/alineo-permission-gate.js";
function buildPiArgs(): string[] {
  const args = ["--mode", "rpc", "--approve"];
  try {
    if (existsSync(PI_CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(PI_CONFIG_FILE, "utf8")) as {
        provider?: string;
        model?: string;
        resume?: boolean;
        permissions?: unknown;
      };
      if (cfg.provider) args.push("--provider", cfg.provider);
      if (cfg.model) args.push("--model", cfg.model);
      if (cfg.resume) args.push("--continue");
      if (cfg.permissions && existsSync(PERMISSION_GATE_PATH)) {
        POLICY_ACTIVE = true;
        args.push("-e", PERMISSION_GATE_PATH);
      }
    }
  } catch {}
  return args;
}

// --- Ring-buffer logger ---
const logBuf: string[] = [];
function log(msg: string): void {
  const entry = "[" + new Date().toISOString() + "] " + msg;
  if (logBuf.length >= 200) logBuf.shift();
  logBuf.push(entry);
  process.stderr.write(entry + "\n");
}

// OpenSandbox's generic port-proxy (what sb.proxy() routes through) proxies via an
// httpx client with no read timeout configured, which falls back to httpx's 5s
// default — so any gap that long between bytes written to an SSE response (model
// "thinking" time, a slow tool call) gets the proxy's connection to us killed,
// surfacing to the caller as either a 500 or a stream that just ends early with
// nothing. A ": ping" comment line is valid SSE (clients ignore lines starting
// with ":") and resets that idle timer without affecting real event data.
function startHeartbeat(res: ServerResponse): Timer {
  return setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 3000);
}
function stopHeartbeat(iv: Timer | undefined): void {
  if (iv) clearInterval(iv);
}

/** Write one SSE `data:` frame. */
function sse(res: ServerResponse, obj: unknown): void {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

// --- Pi process state ---
// All mutable state lives in one object so it's easy to see what changes on restart.
const state: {
  proc: ChildProcess | null; // current ChildProcess
  rl: Interface | null; // readline interface on proc.stdout
  ready: boolean; // true once Pi responds to the get_state probe
  active: PromptItem | null; // the in-flight prompt, if any
  queue: PromptItem[]; // pending items
  gen: number; // incremented on every (re)start; guards against stale async callbacks
  pendingCmds: Record<string, PendingCmd>; // id → command waiting for Pi's response ack
  pendingPermissions: Record<string, PendingPermission>; // pi extension_ui_request id → held dialog
  permissionChannel: { res: ServerResponse } | null; // long-lived SSE sink when no prompt is active
} = {
  proc: null,
  rl: null,
  ready: false,
  active: null,
  queue: [],
  gen: 0,
  pendingCmds: {},
  pendingPermissions: {},
  permissionChannel: null,
};

// Permission-gate dialogs whose title starts with this marker are held + routed to the host
// instead of auto-cancelled. Must match pi-permission-gate.ts's MARKER.
const PERM_MARKER = "ALINEO_PERM ";
const PERMISSION_TIMEOUT_MS = 300000; // 5 min, matches Cline's desktop auto-deny

// Push a permission event to every live SSE sink: the active prompt stream (so a caller
// iterating prompt() sees it inline) AND the dedicated /permission-stream channel (so an
// attached operator sees it even between / across prompts). Both may be present.
function emitPermission(obj: BridgePermissionEvent): void {
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  const sinks = [state.active, state.permissionChannel];
  for (const sink of sinks) {
    if (sink && sink.res) {
      try {
        sink.res.write(line);
      } catch {}
    }
  }
}

// Answer a held Pi extension_ui_request. `value` is a JSON string the gate parses;
// omit it (pass null) to send { cancelled: true } instead.
function answerPermission(id: string, value: string | null): void {
  if (value === null) rpc({ type: "extension_ui_response", id, cancelled: true });
  else rpc({ type: "extension_ui_response", id, value });
}

// Auto-resolve every OTHER pending permission for the same tool — opencode's "one decision
// clears the batch" for an "always" (allow) or "reject" (deny) verdict.
function resolveMatchingPending(exceptId: string, tool: string, verdict: "allow" | "reject"): void {
  for (const pid of Object.keys(state.pendingPermissions)) {
    if (pid === exceptId) continue;
    const p = state.pendingPermissions[pid];
    if (p.tool !== tool) continue;
    if (p.timer) clearTimeout(p.timer);
    delete state.pendingPermissions[pid];
    answerPermission(
      pid,
      verdict === "allow"
        ? JSON.stringify({ verdict: "allow", scope: "once" })
        : JSON.stringify({ verdict: "reject" }),
    );
    emitPermission({
      type: "permission_resolved",
      requestId: pid,
      decision: verdict === "allow" ? { kind: "once" } : { kind: "reject" },
    });
  }
}

// Time a held permission request out: answer the gate as cancelled + tell the host.
function expirePermission(pid: string): void {
  if (!state.pendingPermissions[pid]) return;
  delete state.pendingPermissions[pid];
  answerPermission(pid, null);
  emitPermission({ type: "permission_resolved", requestId: pid, decision: { kind: "reject" } });
}

// While a caller is attached to /permission-stream a human is present, so the auto-deny
// timeout is suspended; it's re-armed (fresh full window) when they disconnect.
function suspendPermissionTimers(): void {
  for (const pid of Object.keys(state.pendingPermissions)) {
    const p = state.pendingPermissions[pid];
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  }
}
function resumePermissionTimers(): void {
  for (const pid of Object.keys(state.pendingPermissions)) {
    const p = state.pendingPermissions[pid];
    if (!p.timer) {
      p.timer = setTimeout(() => {
        expirePermission(pid);
      }, PERMISSION_TIMEOUT_MS);
    }
  }
}

// Fail every held permission request (pi restart, abort, exit).
function cancelPendingPermissions(): void {
  for (const pid of Object.keys(state.pendingPermissions)) {
    const p = state.pendingPermissions[pid];
    if (p.timer) clearTimeout(p.timer);
    answerPermission(pid, null);
  }
  state.pendingPermissions = {};
}

// Fail all in-flight pendingCmds cleanly, handling bash (SSE) vs regular (JSON) responses.
function cleanupPendingCmds(reason: string): void {
  for (const id of Object.keys(state.pendingCmds)) {
    const p = state.pendingCmds[id];
    if (p.timer) clearTimeout(p.timer);
    stopHeartbeat(p.heartbeat);
    if (p.bash) {
      try {
        sse(p.res, { error: reason });
        p.res.end();
      } catch {}
    } else {
      respond(p.res, 500, { ok: false, error: reason });
    }
  }
  state.pendingCmds = {};
}

function startPi(): void {
  // End any in-flight SSE stream so the client isn't left hanging.
  if (state.active) {
    stopHeartbeat(state.active.heartbeat);
    sse(state.active.res, { error: "pi restarted" });
    state.active.res.end();
    state.active = null;
  }
  cleanupPendingCmds("pi restarted");
  cancelPendingPermissions();

  if (state.rl) {
    try {
      state.rl.close();
    } catch {}
  }
  if (state.proc) {
    try {
      state.proc.kill("SIGTERM");
    } catch {}
  }
  state.proc = null;
  state.rl = null;
  state.ready = false;
  // NB: state.queue is intentionally preserved — queued prompts are re-sent to the new Pi.

  loadEnv();
  const args = buildPiArgs();
  const gen = ++state.gen;
  log("pi start gen=" + gen + ": " + args.join(" "));

  const proc = spawn(PI_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env),
  });
  state.proc = proc;

  proc.stderr.on("data", (chunk: Buffer) => {
    if (state.gen === gen) log("pi stderr: " + chunk.toString().trim());
  });

  state.rl = createInterface({ input: proc.stdout });
  state.rl.on("line", (line) => {
    if (state.gen === gen) handleLine(line);
  });

  proc.on("exit", (code) => {
    if (state.gen !== gen) return;
    log("pi exit gen=" + gen + " code=" + code);
    state.proc = null;
    state.ready = false;
    cleanupPendingCmds("pi exited");
    cancelPendingPermissions();
    if (state.active) {
      stopHeartbeat(state.active.heartbeat);
      sse(state.active.res, { error: "pi exited" });
      state.active.res.end();
      state.active = null;
    }
  });

  // Pi needs ~500ms to initialise its RPC layer before it can handle commands.
  setTimeout(() => {
    if (state.gen !== gen || !state.proc) return;
    log("pi probe gen=" + gen);
    rpc({ id: "__probe__", type: "get_state" });
  }, 500);
}

// Write a JSON-RPC message to Pi's stdin.
function rpc(msg: Record<string, unknown>): void {
  if (state.proc && state.proc.stdin) state.proc.stdin.write(JSON.stringify(msg) + "\n");
}

// Send an RPC command and hold the HTTP response open until Pi acks it.
function rpcWithAck(msg: { id: string } & Record<string, unknown>, res: ServerResponse): void {
  const pending: PendingCmd = { res };
  state.pendingCmds[msg.id] = pending;
  rpc(msg);
  pending.timer = setTimeout(() => {
    const p = state.pendingCmds[msg.id];
    if (p) {
      respond(p.res, 504, { error: "timeout" });
      delete state.pendingCmds[msg.id];
    }
  }, 5000);
}

// Dispatch a single line of output from Pi's stdout.
function handleLine(line: string): void {
  if (!line.trim()) return;
  let ev: PiLine;
  try {
    ev = JSON.parse(line) as PiLine;
  } catch {
    return;
  }

  if (!state.ready && ev.id === "__probe__" && ev.type === "response") {
    state.ready = true;
    const m: { id?: string; api?: string } = (ev.data && ev.data.model) || {};
    log("pi ready model=" + m.id + " api=" + m.api);
    flush();
    return;
  }

  // A "prompt" command's own ack is not tracked in pendingCmds (only via
  // state.active) — if Pi rejects it outright (e.g. no API key configured for
  // the provider), no agent_end will ever follow, and without this the client
  // would hang forever behind the heartbeat instead of seeing a clean error.
  if (ev.type === "response" && ev.command === "prompt" && !ev.success) {
    if (!state.active) return;
    stopHeartbeat(state.active.heartbeat);
    log("prompt rejected: " + (ev.error || "unknown"));
    sse(state.active.res, { error: ev.error || "prompt rejected" });
    state.active.res.end();
    state.active = null;
    flush();
    return;
  }

  // Resolve a pending command ack.
  // Bash returns output synchronously in ev.data — stream it as SSE then send [DONE].
  // All other commands use JSON response.
  if (ev.type === "response" && ev.id && state.pendingCmds[ev.id]) {
    const pending = state.pendingCmds[ev.id];
    if (pending.timer) clearTimeout(pending.timer);
    stopHeartbeat(pending.heartbeat);
    delete state.pendingCmds[ev.id];
    if (pending.bash) {
      const output = (ev.data && ev.data.output) || "";
      if (output)
        try {
          sse(pending.res, { type: "text", text: output });
        } catch {}
      try {
        pending.res.write("data: [DONE]\n\n");
        pending.res.end();
      } catch {}
    } else if (ev.success) {
      respond(pending.res, 200, { ok: true, data: ev.data || null });
    } else {
      respond(pending.res, 400, { ok: false, error: ev.error || "unknown" });
    }
    return;
  }

  // Tool execution events: forward into the active prompt stream.
  if (ev.type === "tool_execution_start") {
    if (!state.active) return;
    sse(state.active.res, {
      type: "tool_start",
      toolCallId: ev.toolCallId,
      toolName: ev.toolName,
      args: ev.args,
    });
    return;
  }
  if (ev.type === "tool_execution_update") {
    if (!state.active) return;
    sse(state.active.res, {
      type: "tool_update",
      toolCallId: ev.toolCallId,
      toolName: ev.toolName,
      partialResult: ev.partialResult,
    });
    return;
  }
  if (ev.type === "tool_execution_end") {
    if (!state.active) return;
    sse(state.active.res, {
      type: "tool_end",
      toolCallId: ev.toolCallId,
      toolName: ev.toolName,
      result: ev.result,
      isError: !!ev.isError,
    });
    return;
  }

  // Extension UI requests from Pi extensions.
  // Dialog methods (select/confirm/input/editor) block Pi waiting for extension_ui_response.
  // We auto-cancel them immediately so Pi never stalls — even when there is no active prompt.
  // Fire-and-forget methods need no response; we just forward them.
  if (ev.type === "extension_ui_request") {
    // alineo permission-gate dialog: title is `ALINEO_PERM {json}`. Hold it open, route it
    // to the host as a permission_request, and wait for POST /permission-response.
    if (
      POLICY_ACTIVE &&
      ev.method === "select" &&
      ev.id &&
      typeof ev.title === "string" &&
      ev.title.indexOf(PERM_MARKER) === 0
    ) {
      let meta: { tool?: string; target?: string; title?: string } = {};
      try {
        meta = JSON.parse(ev.title.slice(PERM_MARKER.length)) as typeof meta;
      } catch {}
      const requestId = ev.id;
      const entry: PendingPermission = {
        tool: meta.tool || "unknown",
        target: meta.target || "",
        title: meta.title || "Approve tool call",
        since: Date.now(),
        timer: null,
      };
      // No auto-deny clock while a human is watching the permission stream.
      if (!state.permissionChannel) {
        entry.timer = setTimeout(() => {
          expirePermission(requestId);
        }, PERMISSION_TIMEOUT_MS);
      }
      state.pendingPermissions[requestId] = entry;
      emitPermission({
        type: "permission_request",
        requestId,
        tool: entry.tool,
        target: entry.target,
        title: entry.title,
      });
      return;
    }

    const DIALOG_METHODS = ["select", "confirm", "input", "editor"];
    const isDialog = DIALOG_METHODS.indexOf(ev.method ?? "") !== -1;
    const uiParams: Record<string, unknown> = {};
    for (const k of Object.keys(ev)) {
      if (k !== "type" && k !== "id") uiParams[k] = ev[k];
    }
    if (state.active) {
      sse(state.active.res, {
        type: "extension_ui",
        method: ev.method,
        params: uiParams,
        isDialog,
        requestId: isDialog ? ev.id : undefined,
      });
    }
    if (isDialog && ev.id) {
      rpc({ type: "extension_ui_response", id: ev.id, cancelled: true });
    }
    return;
  }

  if (ev.type === "auto_retry_start") {
    if (state.active) {
      sse(state.active.res, {
        type: "auto_retry_start",
        attempt: ev.attempt,
        maxAttempts: ev.maxAttempts,
        delayMs: ev.delayMs,
        errorMessage: ev.errorMessage || "",
      });
    }
    return;
  }

  if (ev.type === "auto_retry_end") {
    if (state.active) {
      sse(state.active.res, {
        type: "auto_retry_end",
        success: !!ev.success,
        attempt: ev.attempt,
        finalError: ev.finalError,
      });
    }
    return;
  }

  if (ev.type === "agent_start") {
    if (state.active) sse(state.active.res, { type: "agent_start" });
    return;
  }
  if (ev.type === "turn_start") {
    if (state.active) {
      sse(state.active.res, {
        type: "turn_start",
        turnIndex: ev.turnIndex,
        timestamp: ev.timestamp,
      });
    }
    return;
  }
  if (ev.type === "turn_end") {
    if (state.active) {
      sse(state.active.res, {
        type: "turn_end",
        turnIndex: ev.turnIndex,
        message: ev.message,
        toolResults: ev.toolResults || [],
      });
    }
    return;
  }
  if (ev.type === "message_start") {
    if (state.active) sse(state.active.res, { type: "message_start", message: ev.message });
    return;
  }
  if (ev.type === "message_end") {
    if (state.active) sse(state.active.res, { type: "message_end", message: ev.message });
    return;
  }
  if (ev.type === "queue_update") {
    if (state.active) {
      sse(state.active.res, {
        type: "queue_update",
        steering: ev.steering || [],
        followUp: ev.followUp || [],
      });
    }
    return;
  }
  if (ev.type === "compaction_start") {
    if (state.active) sse(state.active.res, { type: "compaction_start", reason: ev.reason });
    return;
  }
  if (ev.type === "compaction_end") {
    if (state.active) {
      sse(state.active.res, {
        type: "compaction_end",
        reason: ev.reason,
        result: ev.result || null,
        aborted: !!ev.aborted,
        willRetry: !!ev.willRetry,
      });
    }
    return;
  }
  if (ev.type === "extension_error") {
    if (state.active) {
      sse(state.active.res, {
        type: "extension_error",
        extensionPath: ev.extensionPath,
        event: ev.event,
        error: ev.error,
      });
    }
    return;
  }

  // message_update: forward the raw delta event, then also extract text_delta as a "text" event
  // so textOnly() keeps working without changes.
  if (ev.type === "message_update") {
    if (!state.active) return;
    sse(state.active.res, {
      type: "message_update",
      message: ev.message,
      delta: ev.assistantMessageEvent,
    });
    const aev = ev.assistantMessageEvent || {};
    if (aev.type === "text_delta" && aev.delta) {
      state.active.text += aev.delta;
      sse(state.active.res, { type: "text", text: aev.delta });
    }
    return;
  }
  if (ev.type === "agent_end") {
    if (!state.active) return;
    stopHeartbeat(state.active.heartbeat);
    sse(state.active.res, { type: "agent_end", messages: ev.messages || [] });
    log(
      "agent_end: " +
        state.active.text.length +
        " chars in " +
        (Date.now() - state.active.t0) +
        "ms",
    );
    state.active.res.write("data: [DONE]\n\n");
    state.active.res.end();
    state.active = null;
    flush();
  }
}

// Send the next queued item to Pi, if Pi is ready and idle.
// streamingBehavior items ("steer"/"followUp") bypass the active-slot gate and complete immediately.
function flush(): void {
  if (!state.ready || !state.queue.length || !state.proc) return;
  const item = state.queue[0];
  if (state.active && !item.streamingBehavior) return;
  state.queue.shift();
  if (!item.streamingBehavior) state.active = item;
  item.t0 = Date.now();
  const rpcMsg: Record<string, unknown> = {
    id: "p" + item.t0,
    type: "prompt",
    message: item.message,
  };
  if (item.streamingBehavior) rpcMsg.streamingBehavior = item.streamingBehavior;
  rpc(rpcMsg);
  item.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (!item.streamingBehavior) item.heartbeat = startHeartbeat(item.res);
  // Injections don't produce their own SSE body — their output arrives via the active prompt's stream.
  if (item.streamingBehavior) {
    item.res.write("data: [DONE]\n\n");
    item.res.end();
    flush();
  }
}

// HTTP response helpers.
function respond(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {}
}

// --- HTTP server ---
startPi();

createServer((req, res) => {
  // GET endpoints don't need a body.
  if (req.method === "GET") {
    if (req.url === "/health") {
      respond(res, 200, { ok: state.ready });
      return;
    }
    if (req.url === "/logs") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(logBuf.join("\n"));
      return;
    }
    if (req.url === "/permission-stream") {
      // Long-lived SSE sink so permission_request events surface even when no prompt()
      // stream is open. One at a time — a new subscriber replaces the old.
      if (state.permissionChannel) {
        try {
          state.permissionChannel.res.end();
        } catch {}
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const pHeartbeat = startHeartbeat(res);
      state.permissionChannel = { res };
      // A reconnecting operator needs to see what's still outstanding, and the auto-deny
      // clock pauses while they're attached.
      suspendPermissionTimers();
      for (const pid of Object.keys(state.pendingPermissions)) {
        const p = state.pendingPermissions[pid];
        try {
          sse(res, {
            type: "permission_request",
            requestId: pid,
            tool: p.tool,
            target: p.target,
            title: p.title,
          });
        } catch {}
      }
      req.on("close", () => {
        stopHeartbeat(pHeartbeat);
        if (state.permissionChannel && state.permissionChannel.res === res) {
          state.permissionChannel = null;
          resumePermissionTimers();
        }
      });
      return;
    }
    if (req.url === "/pending-permissions") {
      const pending = Object.keys(state.pendingPermissions).map((pid) => {
        const p = state.pendingPermissions[pid];
        return {
          requestId: pid,
          tool: p.tool,
          target: p.target,
          title: p.title,
          since: p.since || 0,
        };
      });
      respond(res, 200, { ok: true, data: { pending } });
      return;
    }
    if (req.url === "/messages") {
      rpcWithAck({ id: "gm" + Date.now(), type: "get_messages" }, res);
      return;
    }
    if (req.url === "/available-models") {
      rpcWithAck({ id: "gam" + Date.now(), type: "get_available_models" }, res);
      return;
    }
    if (req.url === "/state") {
      rpcWithAck({ id: "gs" + Date.now(), type: "get_state" }, res);
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (d: Buffer) => {
    body += d;
  });
  req.on("end", () => {
    let data: BridgeRequestBody = {};
    try {
      if (body) data = JSON.parse(body) as BridgeRequestBody;
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    switch (req.url) {
      case "/prompt":
        state.queue.push({
          message: data.message || "",
          streamingBehavior: data.streamingBehavior,
          res,
          text: "",
          t0: 0,
        });
        flush();
        return;

      case "/bash": {
        // Pi returns bash output synchronously in the ack's data.output — no streaming events.
        if (!state.ready || !state.proc) {
          respond(res, 503, { error: "pi not ready" });
          return;
        }
        const bashId = "b" + Date.now();
        const bashTimer = setTimeout(() => {
          const p = state.pendingCmds[bashId];
          if (p) {
            stopHeartbeat(p.heartbeat);
            delete state.pendingCmds[bashId];
            try {
              sse(res, { error: "bash timeout" });
              res.end();
            } catch {}
          }
        }, 30000);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        state.pendingCmds[bashId] = {
          res,
          timer: bashTimer,
          bash: true,
          heartbeat: startHeartbeat(res),
        };
        rpc({ id: bashId, type: "bash", command: data.command || "" });
        return;
      }

      case "/abort":
        // End the active SSE stream immediately, drain the queue, then wait for Pi's ack.
        // A held permission request would leave Pi's tool_call hook awaiting forever —
        // reject each so the abort can actually unwind.
        cancelPendingPermissions();
        state.queue.length = 0;
        if (state.active) {
          stopHeartbeat(state.active.heartbeat);
          state.active.res.write("data: [DONE]\n\n");
          state.active.res.end();
          state.active = null;
        }
        rpcWithAck({ id: "a" + Date.now(), type: "abort" }, res);
        return;

      case "/steer":
        rpcWithAck({ id: "s" + Date.now(), type: "steer", message: data.message || "" }, res);
        return;

      case "/permission-response": {
        const requestId = data.requestId ?? "";
        const pp = state.pendingPermissions[requestId];
        if (!pp) {
          respond(res, 404, { ok: false, error: "no such pending permission" });
          return;
        }
        if (pp.timer) clearTimeout(pp.timer);
        delete state.pendingPermissions[requestId];
        const decision = data.decision || {};
        if (decision.kind === "once") {
          answerPermission(requestId, JSON.stringify({ verdict: "allow", scope: "once" }));
        } else if (decision.kind === "always") {
          answerPermission(requestId, JSON.stringify({ verdict: "allow", scope: "always" }));
          resolveMatchingPending(requestId, pp.tool, "allow");
        } else {
          answerPermission(
            requestId,
            JSON.stringify({ verdict: "reject", feedback: decision.feedback || "" }),
          );
          resolveMatchingPending(requestId, pp.tool, "reject");
        }
        emitPermission({
          type: "permission_resolved",
          requestId,
          // The host already validated the decision shape; echo it back as sent.
          decision: decision as Extract<
            BridgePermissionEvent,
            { type: "permission_resolved" }
          >["decision"],
        });
        respond(res, 200, { ok: true });
        return;
      }

      case "/follow-up":
        rpcWithAck({ id: "fu" + Date.now(), type: "follow_up", message: data.message || "" }, res);
        return;

      case "/new-session":
        rpcWithAck({ id: "n" + Date.now(), type: "new_session" }, res);
        return;

      case "/fork":
        rpcWithAck({ id: "fk" + Date.now(), type: "fork", entryId: data.entryId || "" }, res);
        return;

      case "/clone":
        rpcWithAck({ id: "cl" + Date.now(), type: "clone" }, res);
        return;

      case "/switch-session":
        rpcWithAck(
          { id: "ss" + Date.now(), type: "switch_session", sessionPath: data.sessionPath || "" },
          res,
        );
        return;

      case "/set-model":
        rpcWithAck(
          {
            id: "sm" + Date.now(),
            type: "set_model",
            provider: data.provider || "",
            modelId: data.modelId || "",
          },
          res,
        );
        return;

      case "/cycle-model":
        rpcWithAck({ id: "cm" + Date.now(), type: "cycle_model" }, res);
        return;

      case "/set-thinking-level":
        rpcWithAck(
          { id: "stl" + Date.now(), type: "set_thinking_level", level: data.level || "medium" },
          res,
        );
        return;

      case "/cycle-thinking-level":
        rpcWithAck({ id: "ctl" + Date.now(), type: "cycle_thinking_level" }, res);
        return;

      case "/compact": {
        const compactMsg: { id: string } & Record<string, unknown> = {
          id: "co" + Date.now(),
          type: "compact",
        };
        if (data.customInstructions) compactMsg.customInstructions = data.customInstructions;
        rpcWithAck(compactMsg, res);
        return;
      }

      case "/set-auto-compaction":
        rpcWithAck(
          { id: "sac" + Date.now(), type: "set_auto_compaction", enabled: !!data.enabled },
          res,
        );
        return;

      case "/set-auto-retry":
        rpcWithAck(
          { id: "sar" + Date.now(), type: "set_auto_retry", enabled: !!data.enabled },
          res,
        );
        return;

      case "/abort-retry":
        rpcWithAck({ id: "ar" + Date.now(), type: "abort_retry" }, res);
        return;

      case "/abort-bash":
        rpcWithAck({ id: "ab" + Date.now(), type: "abort_bash" }, res);
        return;

      case "/get-session-stats":
        rpcWithAck({ id: "gss" + Date.now(), type: "get_session_stats" }, res);
        return;

      case "/get-last-assistant-text":
        rpcWithAck({ id: "glat" + Date.now(), type: "get_last_assistant_text" }, res);
        return;

      case "/get-fork-messages":
        rpcWithAck({ id: "gfm" + Date.now(), type: "get_fork_messages" }, res);
        return;

      case "/get-commands":
        rpcWithAck({ id: "gc" + Date.now(), type: "get_commands" }, res);
        return;

      case "/set-session-name":
        rpcWithAck({ id: "ssn" + Date.now(), type: "set_session_name", name: data.name }, res);
        return;

      case "/set-steering-mode":
        rpcWithAck({ id: "ssm" + Date.now(), type: "set_steering_mode", mode: data.mode }, res);
        return;

      case "/set-follow-up-mode":
        rpcWithAck({ id: "sfum" + Date.now(), type: "set_follow_up_mode", mode: data.mode }, res);
        return;

      case "/export-html":
        rpcWithAck(
          { id: "eh" + Date.now(), type: "export_html", outputPath: data.outputPath },
          res,
        );
        return;

      case "/reload-env":
        // Merge any inline env the host sent, then restart Pi so it picks up the new env file.
        if (data.env && typeof data.env === "object") Object.assign(process.env, data.env);
        startPi();
        respond(res, 200, { ok: true });
        return;

      default:
        res.writeHead(404);
        res.end("not found");
    }
  });
}).listen(PORT, "0.0.0.0", () => {
  process.stderr.write("alineo-bridge :" + PORT + "\n");
});
