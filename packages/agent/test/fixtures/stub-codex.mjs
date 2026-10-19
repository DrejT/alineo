#!/usr/bin/env node
// A stand-in for the `codex` binary. `codex login --with-api-key` exits 0. `codex app-server`
// speaks the JSON-RPC subset the bridge uses and plays the scenario in ALINEO_STUB_SCENARIO,
// with the notification and request names from codex-rs app-server-protocol. No model, no key.
import { createInterface } from "node:readline";

if (process.argv[2] === "login") {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else {
  const sc = JSON.parse(process.env.ALINEO_STUB_SCENARIO || '{"kind":"text","text":"hi"}');
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const note = (method, params) => out({ method, params });
  const threadId = "th-1";
  let turnId = "tu-1";
  let steerSeen = null;
  const waiting = new Map();

  const item = (o) => ({ id: "it-1", ...o });
  const finish = (status, error) =>
    note("turn/completed", { threadId, turn: { id: turnId, status, error: error ?? null } });

  async function play() {
    note("turn/started", { threadId, turn: { id: turnId } });
    switch (sc.kind) {
      case "text":
        note("item/started", { threadId, item: item({ type: "agentMessage", text: "" }) });
        note("item/agentMessage/delta", { threadId, itemId: "it-1", delta: sc.text });
        note("item/completed", { threadId, item: item({ type: "agentMessage", text: sc.text }) });
        return finish("completed");
      case "tool":
        note("item/started", {
          threadId,
          item: item({ type: "commandExecution", command: sc.toolName, cwd: "/" }),
        });
        note("item/commandExecution/outputDelta", { threadId, itemId: "it-1", delta: sc.result });
        note("item/completed", {
          threadId,
          item: item({
            type: "commandExecution",
            command: sc.toolName,
            status: "completed",
            exitCode: 0,
            aggregatedOutput: sc.result,
          }),
        });
        return finish("completed");
      case "hang":
        return; // ends on turn/interrupt
      case "fail":
        // The real app-server reports a failure twice: an error notification, then the turn.
        note("error", { threadId, turnId, willRetry: false, error: { message: sc.message } });
        return finish("failed", { message: sc.message });
      case "permission": {
        out({
          id: "srv-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "it-1", command: sc.target },
        });
        const reply = await new Promise((resolve) => waiting.set("srv-1", resolve));
        const ok =
          reply.result?.decision === "accept" || reply.result?.decision === "acceptForSession";
        note("item/started", {
          threadId,
          item: item({ type: "commandExecution", command: sc.target, cwd: "/" }),
        });
        note("item/completed", {
          threadId,
          item: item({
            type: "commandExecution",
            command: sc.target,
            status: ok ? "completed" : "declined",
            exitCode: ok ? 0 : null,
            aggregatedOutput: ok ? "ok" : null,
          }),
        });
        return finish("completed");
      }
    }
  }

  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) {
      waiting.get(m.id)?.(m);
      return;
    }
    const reply = (result) => out({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "stub-codex/0.0.0" });
      case "thread/start":
        return reply({ thread: { id: threadId } });
      case "thread/resume":
        return reply({ thread: { id: m.params.threadId } });
      case "turn/start":
        reply({ turn: { id: turnId } });
        return void play();
      case "turn/steer":
        steerSeen = m.params;
        reply({ turnId: m.params.expectedTurnId });
        if (sc.kind === "hang" && sc.finishOnSteer) finish("completed");
        return;
      case "turn/interrupt":
        reply({});
        return finish("interrupted");
      case "thread/compact/start":
        return reply({});
      case "thread/fork":
        return reply({ thread: { id: `th-fork-${m.params.lastTurnId}` } });
    }
  });
}
