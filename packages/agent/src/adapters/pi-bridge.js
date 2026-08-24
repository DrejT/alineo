"use strict";
var spawn = require("child_process").spawn;
var createInterface = require("readline").createInterface;
var http = require("http");
var fs = require("fs");

var PORT = 3001;
var ENV_FILE = "/etc/alineo-env";
var PI_CONFIG_FILE = "/etc/alineo-pi.json";

// Re-read /etc/alineo-env into process.env on each Pi (re)start so setEnv() changes take effect.
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  var lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^export ([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/);
    if (m) process.env[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

// Build the pi CLI args from /etc/alineo-pi.json (model/provider config, written by the host).
// Supports: provider, model, resume (--continue to resume the most recent session).
function buildPiArgs() {
  var args = ["--mode", "rpc", "--approve"];
  try {
    if (fs.existsSync(PI_CONFIG_FILE)) {
      var cfg = JSON.parse(fs.readFileSync(PI_CONFIG_FILE, "utf8"));
      if (cfg.provider) args.push("--provider", cfg.provider);
      if (cfg.model) args.push("--model", cfg.model);
      if (cfg.resume) args.push("--continue");
    }
  } catch (e) {}
  return args;
}

// --- Ring-buffer logger ---
var logBuf = [];
function log(msg) {
  var entry = "[" + new Date().toISOString() + "] " + msg;
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
function startHeartbeat(res) {
  return setInterval(function () {
    try {
      res.write(": ping\n\n");
    } catch (e) {}
  }, 3000);
}
function stopHeartbeat(iv) {
  if (iv) clearInterval(iv);
}

// --- Pi process state ---
// All mutable state lives in one object so it's easy to see what changes on restart.
var state = {
  proc: null, // current ChildProcess
  rl: null, // readline interface on proc.stdout
  ready: false, // true once Pi responds to the get_state probe
  active: null, // { message, res, text, t0 } — the in-flight prompt, if any
  queue: [], // pending items: { message, streamingBehavior?, res, text, t0 }
  gen: 0, // incremented on every (re)start; guards against stale async callbacks
  pendingCmds: {}, // id → { res, timer, bash? } — commands waiting for Pi's response ack
};

// Fail all in-flight pendingCmds cleanly, handling bash (SSE) vs regular (JSON) responses.
function cleanupPendingCmds(reason) {
  Object.keys(state.pendingCmds).forEach(function (id) {
    var p = state.pendingCmds[id];
    clearTimeout(p.timer);
    stopHeartbeat(p.heartbeat);
    if (p.bash) {
      try {
        p.res.write("data: " + JSON.stringify({ error: reason }) + "\n\n");
        p.res.end();
      } catch (e) {}
    } else {
      respond(p.res, 500, { ok: false, error: reason });
    }
  });
  state.pendingCmds = {};
}

function startPi() {
  // End any in-flight SSE stream so the client isn't left hanging.
  if (state.active) {
    stopHeartbeat(state.active.heartbeat);
    state.active.res.write("data: " + JSON.stringify({ error: "pi restarted" }) + "\n\n");
    state.active.res.end();
    state.active = null;
  }
  cleanupPendingCmds("pi restarted");

  if (state.rl) {
    try {
      state.rl.close();
    } catch (e) {}
  }
  if (state.proc) {
    try {
      state.proc.kill("SIGTERM");
    } catch (e) {}
  }
  state.proc = null;
  state.rl = null;
  state.ready = false;
  // NB: state.queue is intentionally preserved — queued prompts are re-sent to the new Pi.

  loadEnv();
  var args = buildPiArgs();
  var gen = ++state.gen;
  log("pi start gen=" + gen + ": " + args.join(" "));

  var proc = spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env),
  });
  state.proc = proc;

  proc.stderr.on("data", function (chunk) {
    if (state.gen === gen) log("pi stderr: " + chunk.toString().trim());
  });

  state.rl = createInterface({ input: proc.stdout });
  state.rl.on("line", function (line) {
    if (state.gen === gen) handleLine(line);
  });

  proc.on("exit", function (code) {
    if (state.gen !== gen) return;
    log("pi exit gen=" + gen + " code=" + code);
    state.proc = null;
    state.ready = false;
    cleanupPendingCmds("pi exited");
    if (state.active) {
      stopHeartbeat(state.active.heartbeat);
      state.active.res.write("data: " + JSON.stringify({ error: "pi exited" }) + "\n\n");
      state.active.res.end();
      state.active = null;
    }
  });

  // Pi needs ~500ms to initialise its RPC layer before it can handle commands.
  setTimeout(function () {
    if (state.gen !== gen || !state.proc) return;
    log("pi probe gen=" + gen);
    rpc({ id: "__probe__", type: "get_state" });
  }, 500);
}

// Write a JSON-RPC message to Pi's stdin.
function rpc(msg) {
  if (state.proc) state.proc.stdin.write(JSON.stringify(msg) + "\n");
}

// Send an RPC command and hold the HTTP response open until Pi acks it.
function rpcWithAck(msg, res) {
  state.pendingCmds[msg.id] = { res: res };
  rpc(msg);
  state.pendingCmds[msg.id].timer = setTimeout(function () {
    if (state.pendingCmds[msg.id]) {
      respond(state.pendingCmds[msg.id].res, 504, { error: "timeout" });
      delete state.pendingCmds[msg.id];
    }
  }, 5000);
}

// Dispatch a single line of output from Pi's stdout.
function handleLine(line) {
  if (!line.trim()) return;
  var ev;
  try {
    ev = JSON.parse(line);
  } catch (e) {
    return;
  }

  if (!state.ready && ev.id === "__probe__" && ev.type === "response") {
    state.ready = true;
    var m = (ev.data && ev.data.model) || {};
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
    state.active.res.write(
      "data: " + JSON.stringify({ error: ev.error || "prompt rejected" }) + "\n\n",
    );
    state.active.res.end();
    state.active = null;
    flush();
    return;
  }

  // Resolve a pending command ack.
  // Bash returns output synchronously in ev.data — stream it as SSE then send [DONE].
  // All other commands use JSON response.
  if (ev.type === "response" && ev.id && state.pendingCmds[ev.id]) {
    var pending = state.pendingCmds[ev.id];
    clearTimeout(pending.timer);
    stopHeartbeat(pending.heartbeat);
    delete state.pendingCmds[ev.id];
    if (pending.bash) {
      var output = (ev.data && ev.data.output) || "";
      if (output)
        try {
          pending.res.write("data: " + JSON.stringify({ type: "text", text: output }) + "\n\n");
        } catch (e) {}
      try {
        pending.res.write("data: [DONE]\n\n");
        pending.res.end();
      } catch (e) {}
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
    state.active.res.write(
      "data: " +
        JSON.stringify({
          type: "tool_start",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
        }) +
        "\n\n",
    );
    return;
  }
  if (ev.type === "tool_execution_update") {
    if (!state.active) return;
    state.active.res.write(
      "data: " +
        JSON.stringify({
          type: "tool_update",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          partialResult: ev.partialResult,
        }) +
        "\n\n",
    );
    return;
  }
  if (ev.type === "tool_execution_end") {
    if (!state.active) return;
    state.active.res.write(
      "data: " +
        JSON.stringify({
          type: "tool_end",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          result: ev.result,
          isError: !!ev.isError,
        }) +
        "\n\n",
    );
    return;
  }

  // Extension UI requests from Pi extensions.
  // Dialog methods (select/confirm/input/editor) block Pi waiting for extension_ui_response.
  // We auto-cancel them immediately so Pi never stalls — even when there is no active prompt.
  // Fire-and-forget methods need no response; we just forward them.
  if (ev.type === "extension_ui_request") {
    var DIALOG_METHODS = ["select", "confirm", "input", "editor"];
    var isDialog = DIALOG_METHODS.indexOf(ev.method) !== -1;
    var uiParams = {};
    Object.keys(ev).forEach(function (k) {
      if (k !== "type" && k !== "id") uiParams[k] = ev[k];
    });
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "extension_ui",
            method: ev.method,
            params: uiParams,
            isDialog: isDialog,
            requestId: isDialog ? ev.id : undefined,
          }) +
          "\n\n",
      );
    }
    if (isDialog && ev.id) {
      rpc({ type: "extension_ui_response", id: ev.id, cancelled: true });
    }
    return;
  }

  if (ev.type === "auto_retry_start") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "auto_retry_start",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            errorMessage: ev.errorMessage || "",
          }) +
          "\n\n",
      );
    }
    return;
  }

  if (ev.type === "auto_retry_end") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "auto_retry_end",
            success: !!ev.success,
            attempt: ev.attempt,
            finalError: ev.finalError,
          }) +
          "\n\n",
      );
    }
    return;
  }

  if (ev.type === "agent_start") {
    if (state.active) {
      state.active.res.write("data: " + JSON.stringify({ type: "agent_start" }) + "\n\n");
    }
    return;
  }
  if (ev.type === "turn_start") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({ type: "turn_start", turnIndex: ev.turnIndex, timestamp: ev.timestamp }) +
          "\n\n",
      );
    }
    return;
  }
  if (ev.type === "turn_end") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "turn_end",
            turnIndex: ev.turnIndex,
            message: ev.message,
            toolResults: ev.toolResults || [],
          }) +
          "\n\n",
      );
    }
    return;
  }
  if (ev.type === "message_start") {
    if (state.active) {
      state.active.res.write(
        "data: " + JSON.stringify({ type: "message_start", message: ev.message }) + "\n\n",
      );
    }
    return;
  }
  if (ev.type === "message_end") {
    if (state.active) {
      state.active.res.write(
        "data: " + JSON.stringify({ type: "message_end", message: ev.message }) + "\n\n",
      );
    }
    return;
  }
  if (ev.type === "queue_update") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "queue_update",
            steering: ev.steering || [],
            followUp: ev.followUp || [],
          }) +
          "\n\n",
      );
    }
    return;
  }
  if (ev.type === "compaction_start") {
    if (state.active) {
      state.active.res.write(
        "data: " + JSON.stringify({ type: "compaction_start", reason: ev.reason }) + "\n\n",
      );
    }
    return;
  }
  if (ev.type === "compaction_end") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "compaction_end",
            reason: ev.reason,
            result: ev.result || null,
            aborted: !!ev.aborted,
            willRetry: !!ev.willRetry,
          }) +
          "\n\n",
      );
    }
    return;
  }
  if (ev.type === "extension_error") {
    if (state.active) {
      state.active.res.write(
        "data: " +
          JSON.stringify({
            type: "extension_error",
            extensionPath: ev.extensionPath,
            event: ev.event,
            error: ev.error,
          }) +
          "\n\n",
      );
    }
    return;
  }

  // message_update: forward the raw delta event, then also extract text_delta as a "text" event
  // so textOnly() keeps working without changes.
  if (ev.type === "message_update") {
    if (!state.active) return;
    state.active.res.write(
      "data: " +
        JSON.stringify({
          type: "message_update",
          message: ev.message,
          delta: ev.assistantMessageEvent,
        }) +
        "\n\n",
    );
    var aev = ev.assistantMessageEvent || {};
    if (aev.type === "text_delta" && aev.delta) {
      state.active.text += aev.delta;
      state.active.res.write("data: " + JSON.stringify({ type: "text", text: aev.delta }) + "\n\n");
    }
    return;
  }
  if (ev.type === "agent_end") {
    if (!state.active) return;
    stopHeartbeat(state.active.heartbeat);
    state.active.res.write(
      "data: " + JSON.stringify({ type: "agent_end", messages: ev.messages || [] }) + "\n\n",
    );
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
function flush() {
  if (!state.ready || !state.queue.length || !state.proc) return;
  var item = state.queue[0];
  if (state.active && !item.streamingBehavior) return;
  state.queue.shift();
  if (!item.streamingBehavior) state.active = item;
  item.t0 = Date.now();
  var rpcMsg = { id: "p" + item.t0, type: "prompt", message: item.message };
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
function respond(res, status, body) {
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (e) {}
}

// --- HTTP server ---
startPi();

http
  .createServer(function (req, res) {
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

    var body = "";
    req.on("data", function (d) {
      body += d;
    });
    req.on("end", function () {
      var data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end("bad json");
        return;
      }

      switch (req.url) {
        case "/prompt":
          state.queue.push({
            message: data.message || "",
            streamingBehavior: data.streamingBehavior,
            res: res,
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
          var bashId = "b" + Date.now();
          var bashTimer = setTimeout(function () {
            if (state.pendingCmds[bashId]) {
              stopHeartbeat(state.pendingCmds[bashId].heartbeat);
              delete state.pendingCmds[bashId];
              try {
                res.write("data: " + JSON.stringify({ error: "bash timeout" }) + "\n\n");
                res.end();
              } catch (e) {}
            }
          }, 30000);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          state.pendingCmds[bashId] = {
            res: res,
            timer: bashTimer,
            bash: true,
            heartbeat: startHeartbeat(res),
          };
          rpc({ id: bashId, type: "bash", command: data.command || "" });
          return;
        }

        case "/abort":
          // End the active SSE stream immediately, drain the queue, then wait for Pi's ack.
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

        case "/follow-up":
          rpcWithAck(
            { id: "fu" + Date.now(), type: "follow_up", message: data.message || "" },
            res,
          );
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
          var compactMsg = { id: "co" + Date.now(), type: "compact" };
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
  })
  .listen(PORT, "0.0.0.0", function () {
    process.stderr.write("alineo-bridge :" + PORT + "\n");
  });
