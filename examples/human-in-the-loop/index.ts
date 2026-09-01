/**
 * Human-in-the-loop — a scripted walkthrough of `AgentSpec.permissions`.
 *
 * Runs unattended (no terminal prompts). Shows, in order:
 *   1. `permissions: "readonly"` — the gate strips write/edit/bash from the model's
 *      toolset (via Pi `setActiveTools`), so it physically cannot change the sandbox.
 *   2. `classify` — a `bash` rule that lets read-only commands run without asking, and
 *      pauses anything that writes (compound commands are split on `&&`/`;`/`|` and
 *      flagged if any part writes).
 *   3. `prompt(msg, { onPermission })` — a handler that approves / denies each gated call.
 *   4. deny-with-feedback + a hard `deny` rule — the model reads the reason and adjusts.
 *   5. `agent.listPendingPermissions()` — what's paused right now.
 *   6. the ledger audit trail — every request + resolution, from the storage adapter.
 *
 * Run:  cd examples/human-in-the-loop && bun start
 * Needs: OpenSandbox running (`bunx alineo-cli init`) and NVIDIA_API_KEY in your environment.
 */
import { Alineo, type PermissionDecision, type PermissionRequest } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const rule = (s: string) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

// ── 1. read-only agent: the toolset itself is restricted ───────────────────────
rule('1 · permissions: "readonly" — write/edit/bash are not in the model\'s toolset');

const ro = await Alineo.load(await Bun.file("./agents/readonly-agent.json").json(), { adapter });
try {
  console.log('prompt: "Create a file notes.txt containing the word hello."\n');
  process.stdout.write("> ");
  for await (const ev of ro.prompt(
    "Create a file called notes.txt in the current directory containing the word hello. " +
      "If you cannot, say so in one sentence and explain why.",
  )) {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_start") process.stdout.write(`\n[tool: ${ev.toolName}]\n`);
    else if (ev.type === "permission_request")
      await ro.resolvePermission(ev.requestId, { kind: "reject" });
  }
  const { stdout } = await ro.sandbox.exec(
    "cat notes.txt 2>/dev/null || echo '(no file — read-only held)'",
  );
  console.log(`\n\ncheck: ${stdout.trim()}`);
} finally {
  await ro.close();
}

// ── 2–6. the full gate: classify, onPermission, deny-with-feedback, audit ──────
rule("2 · classify + onPermission — reads run free, writes pause, rm -rf is hard-denied");

const agent = await Alineo.load(await Bun.file("./agents/hitl-agent.json").json(), { adapter });

const toolCalls = new Map<string, { label: string; asked: boolean; blocked: boolean }>();

/** The operator: approve edits, but refuse anything that installs packages. */
async function onPermission(req: PermissionRequest): Promise<PermissionDecision> {
  const pending = await agent.listPendingPermissions();
  const install = /\b(pip|npm|apt|apt-get|yarn|pnpm)\b.*\binstall\b/.test(req.target);
  console.log(
    `\n  ⏸  approval needed — ${req.tool}: ${req.target}` +
      `\n     listPendingPermissions() → ${pending.length}` +
      `\n     → ${install ? "DENY with feedback" : "allow once"}`,
  );
  return install
    ? {
        kind: "reject",
        feedback: "No package installs in this demo — use the Python standard library.",
      }
    : { kind: "once" };
}

try {
  const prompt =
    "Do these steps in order, one tool call at a time. If a step is blocked, note it and continue.\n" +
    "1. Run `ls -la`.\n" +
    "2. Run `cat /etc/os-release && uname -sr`.\n" +
    "3. Create hello.py containing: from datetime import date; print(date.today())\n" +
    "4. Run `python3 hello.py`.\n" +
    "5. Run `pip install requests`.\n" +
    "6. Run `rm -rf /tmp/demo-scratch`.";

  console.log(`${prompt}\n`);
  process.stdout.write("> ");
  for await (const ev of agent.prompt(prompt, { onPermission })) {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_start") {
      const t = (ev.args as { command?: string; path?: string }) ?? {};
      const label = `${ev.toolName} ${t.command ?? t.path ?? ""}`.trim();
      toolCalls.set(ev.toolCallId, { label, asked: false, blocked: false });
      process.stdout.write(`\n[tool: ${label}]`);
    } else if (ev.type === "permission_request") {
      for (const c of toolCalls.values())
        if (c.label === `${ev.tool} ${ev.target}`.trim()) c.asked = true;
    } else if (ev.type === "permission_resolved") {
      process.stdout.write(`  → ${ev.decision.kind}`);
    } else if (ev.type === "tool_end" && ev.isError) {
      const c = toolCalls.get(ev.toolCallId);
      if (c) c.blocked = true;
      process.stdout.write(`\n[blocked: ${JSON.stringify(ev.result).slice(0, 140)}]`);
    }
  }

  const calls = [...toolCalls.values()];
  rule("3 · classify let these run with NO prompt");
  console.log(
    calls
      .filter((c) => !c.asked && !c.blocked)
      .map((c) => `  • ${c.label}`)
      .join("\n") || "  (none)",
  );

  rule("4 · these paused for the operator");
  console.log(
    calls
      .filter((c) => c.asked)
      .map((c) => `  • ${c.label}`)
      .join("\n") || "  (none)",
  );

  rule("4b · blocked outright by a deny rule (no prompt — nobody was asked)");
  console.log(
    calls
      .filter((c) => c.blocked && !c.asked)
      .map((c) => `  • ${c.label}`)
      .join("\n") || "  (none)",
  );

  rule("5 · agent.listPendingPermissions() after the run");
  console.log(`  ${JSON.stringify(await agent.listPendingPermissions())}`);

  rule("6 · ledger audit trail (read back from the storage adapter)");
  for (const e of await adapter.readAll(agent.name, agent.sandboxId)) {
    if (e.event !== "permission_requested" && e.event !== "permission_resolved") continue;
    const p = e.payload as {
      requestId: string;
      tool?: string;
      target?: string;
      decision?: { kind: string };
    };
    const tag = e.event === "permission_requested" ? "REQUESTED" : "RESOLVED ";
    const detail = e.event === "permission_requested" ? `${p.tool}: ${p.target}` : p.decision?.kind;
    console.log(`  ${new Date(e.ts).toISOString()}  ${tag}  ${p.requestId.slice(0, 8)}  ${detail}`);
  }

  const { stdout } = await agent.sandbox.exec(
    "cat hello.py 2>/dev/null || echo '(hello.py not created)'",
  );
  console.log(`\nhello.py in the sandbox:\n${stdout.trim()}`);
} finally {
  await agent.close();
  console.log("\nAlineo closed.");
}
