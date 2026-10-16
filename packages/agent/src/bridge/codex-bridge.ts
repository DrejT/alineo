/**
 * The in-sandbox bridge for Codex: runs `codex app-server --listen stdio://` as a long-lived
 * child, speaks its JSON-RPC (thread / turn / item), and serves the same HTTP+SSE contract as
 * the other bridges (`harness/bridge.ts`), each frame already a `HarnessEvent`.
 *
 * Bundled to one CommonJS file (`dist/codex-bridge.cjs`) and written into the sandbox at
 * `/alineo-bridge.js`. The `codex` binary is installed globally in the sandbox image.
 *
 * Protocol facts used here come from codex-rs `app-server-protocol` (2026-09-13):
 * `turn/start`, `turn/steer` (needs the active turn id), `turn/interrupt`,
 * `thread/compact/start`, `thread/fork` (by `lastTurnId`, the turn cannot be in progress),
 * and the server requests `item/commandExecution/requestApproval` and
 * `item/fileChange/requestApproval`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { evaluatePolicy } from "../permissions.ts";
import type { BridgePermissionDecision, BridgeRequestBody } from "./wire.ts";
import type { NormalizedPermissionPolicy } from "@alineo-labs/schema";

const PORT = Number(process.env.ALINEO_BRIDGE_PORT) || 3001;
const ENV_FILE = process.env.ALINEO_ENV_FILE || "/etc/alineo-env";
const CONFIG_FILE = process.env.ALINEO_CODEX_CONFIG || "/etc/alineo-codex.json";
const THREAD_FILE = process.env.ALINEO_CODEX_THREAD_FILE || "/tmp/alineo-codex-thread";
const CODEX_BIN = process.env.ALINEO_CODEX_BIN || "codex";
const PERMISSION_TIMEOUT_MS = 300000;
const RPC_TIMEOUT_MS = 30000;

interface CodexConfig {
  model?: string;
  resume?: boolean;
  /** Present when the spec asks for a gate. Absent means nothing is asked. */
  permissions?: NormalizedPermissionPolicy;
}

type Frame = Record<string, unknown>;
type Json = Record<string, unknown>;

// --- logging, env, config -----------------------------------------------------------------

const logBuf: string[] = [];
function log(msg: string): void {
  const entry = "[" + new Date().toISOString() + "] " + msg;
  if (logBuf.length >= 200) logBuf.shift();
  logBuf.push(entry);
  process.stderr.write(entry + "\n");
}

function loadEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/);
    if (m) process.env[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function loadConfig(): CodexConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as CodexConfig;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, frame: Frame): void {
  try {
    res.write("data: " + JSON.stringify(frame) + "\n\n");
  } catch {}
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {}
}

// --- JSON-RPC to the app-server -----------------------------------------------------------

let proc: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function write(msg: unknown): void {
  proc?.stdin?.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params?: unknown): Promise<Json> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex app-server ${method} timed out`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    write(params === undefined ? { method, id } : { method, id, params });
  });
}

function failAll(why: string): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(why));
  }
  pending.clear();
}

// --- state --------------------------------------------------------------------------------

interface PendingPermission {
  requestId: string;
  tool: string;
  target: string;
  title: string;
  since: number;
  settle: (d: BridgePermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const state: {
  ready: boolean;
  threadId: string | null;
  active: {
    res: ServerResponse;
    turnId: string | null;
    /** `/abort` arrived before the turn id was known. Interrupt as soon as it is. */
    abortPending: boolean;
    heartbeat: ReturnType<typeof setInterval>;
    finish: () => void;
  } | null;
  pending: Map<string, PendingPermission>;
  alwaysAllow: Set<string>;
  config: CodexConfig;
} = {
  ready: false,
  threadId: null,
  active: null,
  pending: new Map(),
  alwaysAllow: new Set(),
  config: {},
};

/** Interrupt the running turn, once its id is known. */
function interruptIfRequested(): void {
  const a = state.active;
  if (a?.abortPending && a.turnId && state.threadId) {
    a.abortPending = false;
    request("turn/interrupt", { threadId: state.threadId, turnId: a.turnId }).catch(() => {});
  }
}

function emit(frame: Frame): void {
  if (state.active) send(state.active.res, frame);
}

// --- permission gate ----------------------------------------------------------------------

/** Park a request for the host. Resolves with the decision. */
function park(
  requestId: string,
  tool: string,
  target: string,
  title: string,
): Promise<BridgePermissionDecision> {
  return new Promise((resolve) => {
    const settle = (d: BridgePermissionDecision): void => {
      clearTimeout(timer);
      state.pending.delete(requestId);
      resolve(d);
    };
    const timer = setTimeout(() => {
      settle({ kind: "reject", feedback: "Approval timed out." });
    }, PERMISSION_TIMEOUT_MS);
    state.pending.set(requestId, {
      requestId,
      tool,
      target,
      title,
      since: Date.now(),
      settle,
      timer,
    });
    emit({ type: "permission_request", requestId, tool, target, title });
  });
}

/**
 * Decide an approval request from the app-server. `accept`, `acceptForSession` or `decline`.
 * With no policy, everything is accepted (the thread is also started with `approvalPolicy:
 * never`, so none arrive).
 */
async function decide(
  requestId: string,
  tool: string,
  target: string,
): Promise<"accept" | "acceptForSession" | "decline"> {
  const policy = state.config.permissions;
  if (!policy) return "accept";
  if (policy.restrictToTools.length > 0 && !policy.restrictToTools.includes(tool)) return "decline";
  const key = `${tool} ${target}`;
  if (state.alwaysAllow.has(key)) return "accept";
  const { action } = evaluatePolicy(policy, tool, target);
  if (action === "allow") return "accept";
  if (action === "deny") return "decline";

  const decision = await park(requestId, tool, target, `Run ${tool}: ${target}`);
  emit({ type: "permission_resolved", requestId, decision });
  if (decision.kind === "once") return "accept";
  if (decision.kind === "always") {
    state.alwaysAllow.add(key);
    for (const other of [...state.pending.values()]) {
      if (other.tool === tool) other.settle({ kind: "once" });
    }
    return "acceptForSession";
  }
  return "decline";
}

async function onServerRequest(id: number | string, method: string, params: Json): Promise<void> {
  try {
    if (method === "item/commandExecution/requestApproval") {
      const requestId = String(params.approvalId ?? params.itemId ?? id);
      const target = typeof params.command === "string" ? params.command : "";
      write({ id, result: { decision: await decide(requestId, "bash", target) } });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      const requestId = String(params.itemId ?? id);
      const target = typeof params.reason === "string" ? params.reason : "";
      write({ id, result: { decision: await decide(requestId, "edit", target) } });
      return;
    }
    write({ id, error: { code: -32601, message: `Client does not support ${method}` } });
  } catch (e) {
    write({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

// --- notifications -> frames --------------------------------------------------------------

/** The turn id that groups an item, for fork points. Codex forks at turn granularity. */
let currentTurnId: string | null = null;
/**
 * The last error message sent in this turn. Codex reports a failure twice: an `error`
 * notification, then `turn/completed` with the same error. One `error` event is enough.
 */
let lastError: string | null = null;

function toolOf(item: Json): { name: string; args: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "bash", args: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return { name: "edit", args: { changes: item.changes } };
    case "mcpToolCall":
      return { name: `${String(item.server)}/${String(item.tool)}`, args: item.arguments ?? {} };
    case "dynamicToolCall":
      return { name: String(item.tool), args: item.arguments ?? {} };
    default:
      return null;
  }
}

function onNotification(method: string, params: Json): void {
  if (!state.active) return;
  switch (method) {
    case "turn/started": {
      const turn = params.turn as Json | undefined;
      if (typeof turn?.id === "string") {
        currentTurnId = turn.id;
        state.active.turnId = turn.id;
        interruptIfRequested();
      }
      emit({ type: "run_start", sessionRef: state.threadId ?? undefined });
      return;
    }
    case "item/started": {
      const item = (params.item ?? {}) as Json;
      if (item.type === "agentMessage") {
        emit({ type: "message_start", messageId: currentTurnId });
        return;
      }
      const t = toolOf(item);
      if (t && typeof item.id === "string") {
        emit({ type: "tool_start", toolCallId: item.id, toolName: t.name, args: t.args });
      }
      return;
    }
    case "item/agentMessage/delta":
      if (typeof params.delta === "string") emit({ type: "text", text: params.delta });
      return;
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      if (typeof params.delta === "string") emit({ type: "reasoning", text: params.delta });
      return;
    case "item/commandExecution/outputDelta":
      if (typeof params.itemId === "string") {
        emit({
          type: "tool_update",
          toolCallId: params.itemId,
          toolName: "bash",
          partial: params.delta ?? null,
        });
      }
      return;
    case "item/completed": {
      const item = (params.item ?? {}) as Json;
      if (item.type === "agentMessage") {
        emit({ type: "message_end", messageId: currentTurnId });
        return;
      }
      const t = toolOf(item);
      if (t && typeof item.id === "string") {
        const status = String(item.status ?? "");
        const exit = typeof item.exitCode === "number" ? item.exitCode : 0;
        const failed = status === "failed" || status === "declined" || exit !== 0;
        emit({
          type: "tool_end",
          toolCallId: item.id,
          toolName: t.name,
          result: item.aggregatedOutput ?? item.result ?? item.changes ?? null,
          isError: failed,
        });
      }
      return;
    }
    case "error": {
      const error = (params.error ?? {}) as Json;
      const message = typeof error.message === "string" ? error.message : "codex reported an error";
      if (params.willRetry === true) {
        // Codex words a retry as "Reconnecting... 2/5".
        const n = message.match(/(\d+)\s*\/\s*(\d+)/);
        emit({
          type: "retry",
          phase: "start",
          attempt: n ? Number(n[1]) : 1,
          maxAttempts: n ? Number(n[2]) : undefined,
          error: message,
        });
      } else if (message !== lastError) {
        lastError = message;
        emit({ type: "error", message });
      }
      return;
    }
    case "turn/completed": {
      const turn = (params.turn ?? {}) as Json;
      if (typeof turn.id === "string" && state.active.turnId && turn.id !== state.active.turnId) {
        return;
      }
      const status = String(turn.status ?? "completed");
      if (status === "failed") {
        const e = (turn.error ?? {}) as Json;
        const message = typeof e.message === "string" ? e.message : "the turn failed";
        if (message !== lastError) emit({ type: "error", message });
        emit({ type: "done", reason: "error" });
      } else if (status === "interrupted") {
        emit({ type: "done", reason: "aborted" });
      } else {
        emit({ type: "done", reason: "completed" });
      }
      state.active.finish();
      return;
    }
    default:
      return;
  }
}

// --- app-server lifecycle -----------------------------------------------------------------

async function startServer(): Promise<void> {
  loadEnv();
  // Codex reads its key from its own login store. Best effort: store the env key there.
  const key = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY;
  if (key) {
    await new Promise<void>((resolve) => {
      const login = spawn(CODEX_BIN, ["login", "--with-api-key"], {
        stdio: ["pipe", "ignore", "ignore"],
        env: process.env,
      });
      login.on("error", () => {
        resolve();
      });
      login.on("exit", () => {
        resolve();
      });
      login.stdin.end(key + "\n");
    });
  }

  proc = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  proc.on("error", (e) => {
    log("codex app-server failed to start: " + e.message);
  });
  proc.stderr?.on("data", (c: Buffer) => {
    log("codex stderr: " + c.toString().trim().slice(0, 300));
  });
  proc.on("exit", (code) => {
    log("codex app-server exited code=" + code);
    state.ready = false;
    failAll("codex app-server exited");
    if (state.active) {
      emit({ error: "codex app-server exited" });
      state.active.finish();
    }
  });
  if (!proc.stdout) throw new Error("codex app-server has no stdout");
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = msg.id as number | string | undefined;
    if (id !== undefined && typeof msg.method === "string") {
      void onServerRequest(id, msg.method, (msg.params ?? {}) as Json);
      return;
    }
    if (id !== undefined && typeof id === "number") {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as Json;
        p.reject(new Error(typeof e.message === "string" ? e.message : "rpc error"));
      } else {
        p.resolve((msg.result ?? {}) as Json);
      }
      return;
    }
    if (typeof msg.method === "string") onNotification(msg.method, (msg.params ?? {}) as Json);
  });

  await request("initialize", {
    clientInfo: { name: "alineo", title: "alineo", version: "0" },
    capabilities: { experimentalApi: false },
  });
  write({ method: "initialized" });
  state.ready = true;
}

/** Start the thread on the first turn, or resume the one a previous bridge process started. */
async function ensureThread(): Promise<string> {
  if (state.threadId) return state.threadId;
  const policy = state.config.permissions;
  if (state.config.resume && existsSync(THREAD_FILE)) {
    const saved = readFileSync(THREAD_FILE, "utf8").trim();
    if (saved) {
      try {
        await request("thread/resume", { threadId: saved });
        state.threadId = saved;
        return saved;
      } catch (e) {
        log(
          "could not resume thread " + saved + ": " + (e instanceof Error ? e.message : String(e)),
        );
      }
    }
  }
  const params: Json = {
    // Under a policy, Codex asks for everything and the bridge decides. Otherwise it never asks.
    approvalPolicy: policy ? "untrusted" : "never",
    sandbox: policy ? "workspace-write" : "danger-full-access",
    ephemeral: false,
  };
  if (state.config.model) params.model = state.config.model;
  const res = await request("thread/start", params);
  const id = (res.thread as Json | undefined)?.id;
  if (typeof id !== "string") throw new Error("thread/start returned no thread id");
  state.threadId = id;
  try {
    writeFileSync(THREAD_FILE, id);
  } catch {}
  return id;
}

// --- one turn -----------------------------------------------------------------------------

async function runTurn(res: ServerResponse, message: string): Promise<void> {
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 3000);
  let finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  lastError = null;
  state.active = { res, turnId: null, abortPending: false, heartbeat, finish };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  try {
    const threadId = await ensureThread();
    const started = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    const turnId = (started.turn as Json | undefined)?.id;
    if (typeof turnId === "string" && state.active && !state.active.turnId) {
      state.active.turnId = turnId;
      currentTurnId = turnId;
      interruptIfRequested();
    }
    await done;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    log("turn failed: " + text);
    send(res, { error: text });
  } finally {
    clearInterval(heartbeat);
    for (const p of [...state.pending.values()])
      p.settle({ kind: "reject", feedback: "The turn ended." });
    state.active = null;
    try {
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {}
  }
}

// --- HTTP ---------------------------------------------------------------------------------

function main(): void {
  state.config = loadConfig();
  startServer().catch((e: unknown) => {
    log("startup failed: " + (e instanceof Error ? e.message : String(e)));
  });

  createServer((req, res) => {
    if (req.method === "GET") {
      if (req.url === "/health") return respond(res, 200, { ok: state.ready });
      if (req.url === "/logs") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(logBuf.join("\n"));
        return;
      }
      if (req.url === "/state") {
        return respond(res, 200, { ok: true, data: { threadId: state.threadId } });
      }
      if (req.url === "/pending-permissions") {
        const list = [...state.pending.values()].map((p) => ({
          requestId: p.requestId,
          tool: p.tool,
          target: p.target,
          title: p.title,
          since: p.since,
        }));
        return respond(res, 200, { ok: true, data: { pending: list } });
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
          if (!state.ready) return respond(res, 503, { ok: false, error: "codex not ready" });
          if (state.active)
            return respond(res, 409, { ok: false, error: "a turn is already running" });
          void runTurn(res, data.message ?? "");
          return;

        case "/abort": {
          if (state.active) {
            state.active.abortPending = true;
            interruptIfRequested();
          }
          return respond(res, 200, { ok: true, data: null });
        }

        case "/steer": {
          const a = state.active;
          if (!a?.turnId || !state.threadId) {
            return respond(res, 409, { ok: false, error: "no turn in progress" });
          }
          request("turn/steer", {
            threadId: state.threadId,
            expectedTurnId: a.turnId,
            input: [{ type: "text", text: data.message ?? "", text_elements: [] }],
          })
            .then(() => respond(res, 200, { ok: true, data: null }))
            .catch((e: unknown) => {
              respond(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
            });
          return;
        }

        case "/compact": {
          if (!state.threadId) return respond(res, 409, { ok: false, error: "no thread yet" });
          request("thread/compact/start", { threadId: state.threadId })
            .then(() => respond(res, 200, { ok: true, data: null }))
            .catch((e: unknown) => {
              respond(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
            });
          return;
        }

        case "/fork": {
          if (!state.threadId)
            return respond(res, 409, { ok: false, error: "no thread to fork yet" });
          if (state.active) return respond(res, 409, { ok: false, error: "a turn is running" });
          request("thread/fork", { threadId: state.threadId, lastTurnId: data.entryId })
            .then((r) => {
              const id = (r.thread as Json | undefined)?.id;
              if (typeof id !== "string") throw new Error("thread/fork returned no thread id");
              state.threadId = id;
              try {
                writeFileSync(THREAD_FILE, id);
              } catch {}
              respond(res, 200, { ok: true, data: { sessionRef: id } });
            })
            .catch((e: unknown) => {
              respond(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
            });
          return;
        }

        case "/permission-response": {
          const p = state.pending.get(data.requestId ?? "");
          if (!p) return respond(res, 404, { ok: false, error: "no such pending permission" });
          const d = data.decision ?? {};
          p.settle(
            d.kind === "once"
              ? { kind: "once" }
              : d.kind === "always"
                ? { kind: "always" }
                : { kind: "reject", feedback: d.feedback },
          );
          return respond(res, 200, { ok: true });
        }

        default:
          res.writeHead(404);
          res.end("not found");
      }
    });
  }).listen(PORT, "0.0.0.0", () => {
    process.stderr.write("alineo-bridge :" + PORT + "\n");
  });
}

main();
