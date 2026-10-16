/**
 * The in-sandbox bridge for Claude Code: drives the Claude Agent SDK and serves the same
 * HTTP+SSE contract as the Pi bridge (`harness/bridge.ts`), but each frame is already a
 * `HarnessEvent`, because the SDK's messages map straight onto the neutral vocabulary.
 *
 * Bundled to one CommonJS file (`dist/claude-bridge.cjs`) and written into the sandbox at
 * `/alineo-bridge.js`. The Agent SDK is installed globally in the sandbox image and loaded
 * with a dynamic import, so it is not part of the bundle.
 *
 * One turn is one `query()` call. A follow-up turn resumes the session by id.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluatePolicy } from "../permissions.ts";
import type { BridgePermissionDecision, BridgeRequestBody } from "./wire.ts";
import type { NormalizedPermissionPolicy } from "@alineo-labs/schema";

const PORT = Number(process.env.ALINEO_BRIDGE_PORT) || 3001;
const ENV_FILE = process.env.ALINEO_ENV_FILE || "/etc/alineo-env";
const CONFIG_FILE = process.env.ALINEO_CLAUDE_CONFIG || "/etc/alineo-claude.json";
/** Test seam: a stub SDK module. In the sandbox the SDK is found under `npm root -g`. */
const SDK_PATH_OVERRIDE = process.env.ALINEO_CLAUDE_SDK_PATH;
const PERMISSION_TIMEOUT_MS = 300000;

// --- the slice of the Agent SDK this file uses --------------------------------------------

interface SdkContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  /** Set on an assistant message the SDK synthesised for an API error. */
  error?: string;
  message?: { id?: string; content?: SdkContentBlock[] | string };
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
}
interface SdkQuery extends AsyncGenerator<SdkMessage, void> {
  interrupt(): Promise<unknown>;
}
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; title?: string; signal: AbortSignal },
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;
interface SdkModule {
  query(params: { prompt: string; options: Record<string, unknown> }): SdkQuery;
  forkSession(
    sessionId: string,
    options?: { upToMessageId?: string; title?: string },
  ): Promise<{ sessionId: string }>;
}

interface ClaudeConfig {
  model?: string;
  resume?: boolean;
  /** Present when the spec asks for a gate. Absent means every tool call is allowed. */
  permissions?: NormalizedPermissionPolicy;
  /** Spec `env` is in /etc/alineo-env. This is the model provider's base URL, if not Anthropic. */
  systemPrompt?: string;
}

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

function loadConfig(): ClaudeConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function loadSdk(): Promise<SdkModule> {
  const path =
    SDK_PATH_OVERRIDE ??
    join(
      execSync("npm root -g", { encoding: "utf8" }).trim(),
      "@anthropic-ai/claude-agent-sdk/sdk.mjs",
    );
  return (await import(pathToFileURL(path).href)) as SdkModule;
}

// --- frames -------------------------------------------------------------------------------

/** A frame is a `HarnessEvent` as JSON, or `{ error }`. Typed loosely: the host validates. */
type Frame = Record<string, unknown>;

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

// A ": ping" comment resets OpenSandbox's proxy idle timer. See pi-bridge.ts for the story.
function startHeartbeat(res: ServerResponse): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 3000);
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
  sdk: SdkModule | null;
  ready: boolean;
  sessionId: string | null;
  active: {
    res: ServerResponse;
    abort: AbortController;
    heartbeat: ReturnType<typeof setInterval>;
  } | null;
  pending: Map<string, PendingPermission>;
  alwaysAllow: Set<string>;
  rateHits: Map<string, number[]>;
  config: ClaudeConfig;
} = {
  sdk: null,
  ready: false,
  sessionId: null,
  active: null,
  pending: new Map(),
  alwaysAllow: new Set(),
  rateHits: new Map(),
  config: {},
};

// --- permission gate ----------------------------------------------------------------------

/** Claude's tool names are capitalised. Policy rules use Pi's lowercase vocabulary. */
const TOOL_ALIASES: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  grep: "grep",
  glob: "find",
  ls: "ls",
};
function policyToolName(toolName: string): string {
  return TOOL_ALIASES[toolName.toLowerCase()] ?? toolName.toLowerCase();
}

function targetOf(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (tool) {
    case "bash":
      return s(input.command);
    case "read":
    case "write":
    case "edit":
    case "ls":
      return s(input.file_path) || s(input.path);
    case "grep":
    case "find":
      return s(input.pattern);
    default:
      try {
        return JSON.stringify(input);
      } catch {
        return "";
      }
  }
}

function underLimit(key: string, limit: { count: number; windowMs: number } | undefined): boolean {
  if (!limit) return true;
  const now = Date.now();
  const hits = (state.rateHits.get(key) ?? []).filter((t) => t >= now - limit.windowMs);
  if (hits.length >= limit.count) {
    state.rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  state.rateHits.set(key, hits);
  return true;
}

function emitToActive(frame: Frame): void {
  if (state.active) send(state.active.res, frame);
}

const canUseTool: CanUseTool = async (toolName, input, options) => {
  const policy = state.config.permissions;
  const allow = { behavior: "allow" as const, updatedInput: input };
  if (!policy) return allow;

  const tool = policyToolName(toolName);
  if (policy.restrictToTools.length > 0 && !policy.restrictToTools.includes(tool)) {
    return {
      behavior: "deny",
      message: `The operator's policy does not allow the ${toolName} tool.`,
    };
  }
  const target = targetOf(tool, input);
  const key = `${tool} ${target}`;
  if (state.alwaysAllow.has(key)) return allow;

  const { action, rule } = evaluatePolicy(policy, tool, target);
  if (action === "allow") return allow;
  if (action === "deny") {
    return {
      behavior: "deny",
      message: `The operator's policy denies this tool call: ${tool} ${target}`.trim(),
    };
  }
  if (action === "rate_limit") {
    return underLimit(key, rule?.limit)
      ? allow
      : { behavior: "deny", message: `Rate limit reached for ${tool}. Wait before trying again.` };
  }

  // action === "ask": park until the host answers.
  const requestId = options.toolUseID;
  const title = options.title || `Run ${tool}: ${target}`;
  const decision = await new Promise<BridgePermissionDecision>((resolve) => {
    const settle = (d: BridgePermissionDecision): void => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      state.pending.delete(requestId);
      resolve(d);
    };
    const onAbort = (): void => {
      settle({ kind: "reject", feedback: "The turn was aborted." });
    };
    const timer = setTimeout(() => {
      settle({ kind: "reject", feedback: "Approval timed out." });
    }, PERMISSION_TIMEOUT_MS);
    options.signal.addEventListener("abort", onAbort);
    state.pending.set(requestId, {
      requestId,
      tool,
      target,
      title,
      since: Date.now(),
      settle,
      timer,
    });
    emitToActive({ type: "permission_request", requestId, tool, target, title });
  });
  emitToActive({ type: "permission_resolved", requestId, decision });

  if (decision.kind === "once") return allow;
  if (decision.kind === "always") {
    state.alwaysAllow.add(key);
    // One "always" clears every other held request for the same tool, as in the Pi bridge.
    for (const other of [...state.pending.values()]) {
      if (other.tool === tool) other.settle({ kind: "once" });
    }
    return allow;
  }
  return {
    behavior: "deny",
    message: decision.feedback
      ? `The operator declined this and said: ${decision.feedback}`
      : "The operator declined this tool call.",
  };
};

// --- SDK message -> frames ----------------------------------------------------------------

const toolNames = new Map<string, string>();

/** Map one SDK message to zero or more frames. `streamed` tracks text already sent as deltas. */
function mapMessage(msg: SdkMessage, ctx: { streamed: boolean }): Frame[] {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init" && msg.session_id) {
        state.sessionId = msg.session_id;
        return [{ type: "run_start", sessionRef: msg.session_id }];
      }
      return [];

    case "stream_event": {
      const d = msg.event?.type === "content_block_delta" ? msg.event.delta : undefined;
      if (d?.type === "text_delta" && d.text) {
        ctx.streamed = true;
        return [{ type: "text", text: d.text }];
      }
      if (d?.type === "thinking_delta" && d.thinking)
        return [{ type: "reasoning", text: d.thinking }];
      return [];
    }

    case "assistant": {
      const messageId = msg.uuid ?? null;
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const out: Frame[] = [{ type: "message_start", messageId }];
      for (const b of blocks) {
        // An API error arrives as an assistant message whose text is the error. The `result`
        // that follows reports it, so it is not also prose.
        if (b.type === "text" && b.text && !ctx.streamed && !msg.error) {
          out.push({ type: "text", text: b.text });
        }
        if (b.type === "tool_use" && b.id && b.name) {
          toolNames.set(b.id, b.name);
          out.push({ type: "tool_start", toolCallId: b.id, toolName: b.name, args: b.input ?? {} });
        }
      }
      out.push({ type: "message_end", messageId });
      ctx.streamed = false;
      return out;
    }

    case "user": {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const out: Frame[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result" && b.tool_use_id) {
          out.push({
            type: "tool_end",
            toolCallId: b.tool_use_id,
            toolName: toolNames.get(b.tool_use_id) ?? "unknown",
            result: b.content ?? null,
            isError: !!b.is_error,
          });
        }
      }
      return out;
    }

    case "result": {
      if (msg.subtype === "success" && !msg.is_error)
        return [{ type: "done", reason: "completed" }];
      const why = msg.result || msg.errors?.join("; ") || msg.subtype || "the turn failed";
      return [
        { type: "error", message: why },
        { type: "done", reason: "error" },
      ];
    }

    default:
      return [];
  }
}

// --- one turn -----------------------------------------------------------------------------

async function runTurn(res: ServerResponse, message: string): Promise<void> {
  const abort = new AbortController();
  const heartbeat = startHeartbeat(res);
  state.active = { res, abort, heartbeat };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let finished = false;
  try {
    const sdk = state.sdk;
    if (!sdk) throw new Error("the Claude Agent SDK is not loaded");
    loadEnv();
    const options: Record<string, unknown> = {
      abortController: abort,
      canUseTool,
      includePartialMessages: true,
      permissionMode: "default",
      settingSources: [],
      systemPrompt: state.config.systemPrompt ?? { type: "preset", preset: "claude_code" },
      env: { ...process.env },
    };
    if (state.config.model) options.model = state.config.model;
    if (state.sessionId) options.resume = state.sessionId;
    else if (state.config.resume) options.continue = true;

    const ctx = { streamed: false };
    const q = sdk.query({ prompt: message, options });
    for await (const msg of q) {
      for (const frame of mapMessage(msg, ctx)) {
        send(res, frame);
        if (frame.type === "done") finished = true;
      }
    }
    // The SDK stream ended with no result: the turn was aborted.
    if (!finished) send(res, { type: "done", reason: abort.signal.aborted ? "aborted" : "error" });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (finished) {
      // The SDK throws after an error `result` it has already reported. `done` was sent, and a
      // turn has exactly one, so this is only logged.
      log("sdk threw after the result: " + text);
    } else if (abort.signal.aborted) {
      send(res, { type: "done", reason: "aborted" });
    } else {
      log("turn failed: " + text);
      send(res, { error: text });
    }
  } finally {
    clearInterval(heartbeat);
    for (const p of [...state.pending.values()]) {
      p.settle({ kind: "reject", feedback: "The turn ended." });
    }
    state.active = null;
    try {
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {}
  }
}

// --- HTTP ---------------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  state.config = loadConfig();
  try {
    state.sdk = await loadSdk();
    state.ready = true;
    log("claude agent sdk loaded");
  } catch (e) {
    log("could not load the claude agent sdk: " + (e instanceof Error ? e.message : String(e)));
  }

  createServer((req, res) => {
    if (req.method === "GET") {
      if (req.url === "/health") return respond(res, 200, { ok: state.ready });
      if (req.url === "/logs") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(logBuf.join("\n"));
        return;
      }
      if (req.url === "/state") {
        return respond(res, 200, { ok: true, data: { sessionId: state.sessionId } });
      }
      if (req.url === "/pending-permissions") {
        const pending = [...state.pending.values()].map((p) => ({
          requestId: p.requestId,
          tool: p.tool,
          target: p.target,
          title: p.title,
          since: p.since,
        }));
        return respond(res, 200, { ok: true, data: { pending } });
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
          if (!state.ready) return respond(res, 503, { ok: false, error: "claude sdk not loaded" });
          if (state.active) {
            return respond(res, 409, { ok: false, error: "a turn is already running" });
          }
          void runTurn(res, data.message ?? "");
          return;

        case "/abort":
          if (state.active) state.active.abort.abort();
          return respond(res, 200, { ok: true, data: null });

        case "/fork": {
          const sdk = state.sdk;
          if (!sdk || !state.sessionId) {
            return respond(res, 409, { ok: false, error: "there is no session to fork yet" });
          }
          if (state.active) return respond(res, 409, { ok: false, error: "a turn is running" });
          sdk
            .forkSession(state.sessionId, { upToMessageId: data.entryId })
            .then((forked) => {
              state.sessionId = forked.sessionId;
              respond(res, 200, { ok: true, data: { sessionRef: forked.sessionId } });
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

void main();
