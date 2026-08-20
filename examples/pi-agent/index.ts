/**
 * Pi agent example — exercises every alineo command:
 *
 *   prompt, bash, steer, followUp, abort, newSession
 *   getMessages, getAvailableModels
 *   setModel, cycleModel, setThinkingLevel, cycleThinkingLevel
 *   setAutoCompaction, compact
 *   clone, fork
 *   setAutoRetry, abortRetry
 *   abortBash, getSessionStats, getLastAssistantText, getForkMessages
 *   getCommands, setSessionName, setSteeringMode, setFollowUpMode, exportHtml
 *   setEnv, getLogs
 *   sandbox.exec, sandbox.writeFile, sandbox.readFile
 *
 * Run:  cd examples/pi-agent && bun index.ts
 * Needs: OpenSandbox running (alineo init) and NVIDIA_API_KEY in .env
 */
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const agent = await Alineo.load("./agents/hello-agent.json", { adapter });
console.log(`\nSandbox: ${agent.sandboxId}\n${"─".repeat(60)}`);
await agent.sandbox.exec("mkdir -p /workspace");

try {
  // ── 1. prompt (SSE streaming) ─────────────────────────────────────────────────
  // Provide data inline so Pi answers directly without a tool call.
  section("1. prompt — SSE streaming");
  await agent.sandbox.writeFile(
    "/workspace/data.csv",
    ["date,temp_c", "2024-01-15,22.3", "2024-01-16,19.8", "2024-01-17,25.1"].join("\n") + "\n",
  );
  for await (const chunk of textOnly(
    agent.prompt(
      "Here is some CSV data:\ndate,temp_c\n2024-01-15,22.3\n2024-01-16,19.8\n2024-01-17,25.1\nTell me the min and max temp_c in one sentence.",
    ),
  )) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  // ── 2. bash ───────────────────────────────────────────────────────────────────
  // Runs a shell command inside Pi's working context and streams stdout.
  section("2. bash — run shell command via Pi");
  for await (const chunk of textOnly(
    agent.bash("ls -1 /workspace && echo '---' && python3 --version"),
  )) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  // ── 3. getMessages ────────────────────────────────────────────────────────────
  section("3. getMessages — inspect conversation history");
  const messages = await agent.getMessages();
  console.log(`Conversation has ${messages.length} message(s).`);
  const firstUserMsg = messages.find((m) => m.role === "user");
  console.log(`First user message keys: ${Object.keys(firstUserMsg ?? {}).join(", ")}\n`);

  // ── 4. getAvailableModels ─────────────────────────────────────────────────────
  section("4. getAvailableModels — list configured models");
  const models = await agent.getAvailableModels();
  console.log(`${models.length} model(s) available:`);
  for (const m of models) console.log(`  ${m.api}/${m.id}`);
  console.log();

  // ── 5. setModel / cycleModel ──────────────────────────────────────────────────
  // setModel only works with models in Pi's config (not just the full provider list).
  section("5. setModel + cycleModel — switch models at runtime");
  if (models.length > 0) {
    try {
      const set = await agent.setModel(models[0].api as string, models[0].id);
      console.log(`setModel → ${set.api}/${set.id}`);
    } catch (e) {
      console.log(`setModel(${models[0].id}) → not in Pi config: ${(e as Error).message}`);
    }
  }
  const cycled = await agent.cycleModel();
  if (cycled) {
    console.log(
      `cycleModel → ${cycled.model.api}/${cycled.model.id} (thinking: ${cycled.thinkingLevel})`,
    );
  } else {
    console.log("cycleModel → only one model configured, no change");
  }
  console.log();

  // ── 6. setThinkingLevel / cycleThinkingLevel ──────────────────────────────────
  section("6. setThinkingLevel + cycleThinkingLevel");
  try {
    await agent.setThinkingLevel("low");
    console.log("setThinkingLevel(low) → ok");
    const tl = await agent.cycleThinkingLevel();
    console.log(`cycleThinkingLevel → ${tl?.level ?? "model does not support thinking"}`);
  } catch (e) {
    console.log(`thinking not supported by current model: ${(e as Error).message}`);
  }
  console.log();

  // ── 7. setAutoCompaction ─────────────────────────────────────────────────────
  section("7. setAutoCompaction");
  await agent.setAutoCompaction(false);
  console.log("setAutoCompaction(false) → ok");
  await agent.setAutoCompaction(true);
  console.log("setAutoCompaction(true) → ok\n");

  // ── 8. steer mid-flight ───────────────────────────────────────────────────────
  section("8. steer — redirect Pi mid-response");
  const longStream = textOnly(
    agent.prompt(
      "Write a detailed essay on every sorting algorithm ever invented with pseudocode.",
    ),
  );
  const steerTimer = setTimeout(async () => {
    try {
      await agent.steer("Stop — give me just 3 bullet points instead.");
      console.log("\n[host] steer acknowledged\n");
    } catch {
      // Pi may have already finished
    }
  }, 1500);
  for await (const chunk of longStream) {
    process.stdout.write(chunk);
  }
  clearTimeout(steerTimer);
  console.log("\n");

  // ── 9. followUp ───────────────────────────────────────────────────────────────
  // Queue a message that Pi will process after its current task completes.
  section("9. followUp — queue message for after current task");
  const followStream = textOnly(agent.prompt("Count from 1 to 5, one number per line."));
  await agent.followUp("Now count backwards from 5 to 1, one number per line.");
  for await (const chunk of followStream) {
    process.stdout.write(chunk);
  }
  console.log("\n");
  // The followUp was queued inside Pi — send an empty prompt to drain it.
  section("9b. drain the followUp turn");
  for await (const chunk of textOnly(agent.prompt("(continue)"))) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  // ── 10. clone ─────────────────────────────────────────────────────────────────
  // Clone creates a new Pi session branch at the current position.
  section("10. clone — branch current session");
  const cloned = await agent.clone();
  console.log(`clone → cancelled: ${cloned.cancelled}\n`);

  // ── 11. fork ──────────────────────────────────────────────────────────────────
  // Fork branches from a specific user message entry in the history.
  section("11. fork — branch from a specific history entry");
  const history = await agent.getMessages();
  const forkableMsg = history.find((m) => m.role === "user" && (m.id ?? m.entryId));
  if (forkableMsg) {
    const entryId = (forkableMsg.id ?? forkableMsg.entryId) as string;
    try {
      const forked = await agent.fork(entryId);
      console.log(`fork(${entryId.slice(0, 12)}…) → cancelled: ${forked.cancelled}`);
      console.log(`  forked from: "${String(forked.text).slice(0, 60)}…"`);
    } catch (e) {
      console.log(`fork failed: ${(e as Error).message}`);
    }
  } else {
    console.log("no forkable message found (id field not exposed for this model)");
  }
  console.log();

  // ── 12. compact + newSession + final task ────────────────────────────────────
  section("12. compact — session now has many messages, should succeed");
  try {
    const compacted = await agent.compact();
    console.log(
      `compact → ${compacted.tokensBefore} tokens before, ~${compacted.estimatedTokensAfter} after`,
    );
  } catch (e) {
    console.log(`compact → skipped: ${(e as Error).message}`);
  }
  console.log();

  section("12b. newSession — clear context, filesystem unchanged");
  await agent.newSession();
  console.log("Session reset.\n");

  await agent.sandbox.writeFile("/workspace/hello.py", 'print("hello from Pi sandbox")\n');
  for await (const chunk of textOnly(
    agent.prompt("Run /workspace/hello.py with python3 and tell me what it prints."),
  )) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  // ── 13. setAutoRetry — toggle Pi's built-in transient-error retry ────────────
  // Auto-retry is ON by default (3 attempts, 2s/4s/8s exponential backoff).
  // Disable it when you want to handle transient failures yourself via events.
  section("13. setAutoRetry — toggle transient-error retry");
  await agent.setAutoRetry(false);
  console.log("setAutoRetry(false) → ok (retry disabled)");
  await agent.setAutoRetry(true);
  console.log("setAutoRetry(true)  → ok (retry re-enabled)\n");

  // To observe retry events, iterate the raw AgentStream:
  // (We can't force a transient error here, so we just show the pattern.)
  console.log("Retry event pattern (fires automatically on 429/5xx):");
  console.log(
    "  { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '...' }",
  );
  console.log("  { type: 'auto_retry_end',   success: true, attempt: 1 }");
  console.log(
    "\nTo observe live, iterate agent.prompt() and switch on ev.type === 'auto_retry_start'.\n",
  );

  // ── 14. abortRetry — cancel an in-progress retry ─────────────────────────────
  // abortRetry() is a no-op if no retry is currently pending.
  // In production use it to let users cancel a stuck retry immediately.
  section("14. abortRetry — cancel in-progress retry (no-op if idle)");
  await agent.abortRetry();
  console.log("abortRetry() → ok\n");

  // ── 15. abortBash — stop a running bash without cancelling the prompt ────────
  // No-op when idle; useful to interrupt a long-running shell command mid-flight.
  section("15. abortBash — stop running bash (no-op if idle)");
  await agent.abortBash();
  console.log("abortBash() → ok\n");

  // ── 16. getSessionStats — token usage + cost ──────────────────────────────────
  section("16. getSessionStats — token usage and cost");
  const stats = await agent.getSessionStats();
  console.log(`sessionId:        ${stats.sessionId}`);
  console.log(`messages:         ${stats.userMessages} user, ${stats.assistantMessages} assistant`);
  console.log(`toolCalls:        ${stats.toolCalls}`);
  console.log(
    `tokens:           ${stats.tokens.input} in, ${stats.tokens.output} out, ${stats.tokens.total} total`,
  );
  console.log(`cost:             $${stats.cost.toFixed(6)}`);
  if (stats.contextUsage) {
    console.log(
      `contextUsage:     ${stats.contextUsage.percent.toFixed(1)}% (${stats.contextUsage.tokens}/${stats.contextUsage.contextWindow})`,
    );
  }
  console.log();

  // ── 17. getLastAssistantText ──────────────────────────────────────────────────
  section("17. getLastAssistantText — last Pi response (no stream needed)");
  const lastText = await agent.getLastAssistantText();
  if (lastText) {
    console.log(
      `Last response (first 120 chars): "${lastText.slice(0, 120).replace(/\n/g, " ")}…"`,
    );
  } else {
    console.log("No assistant response yet.");
  }
  console.log();

  // ── 18. getForkMessages — list fork entry points in current session ───────────
  section("18. getForkMessages — list fork entry points");
  const forkMessages = await agent.getForkMessages();
  console.log(`${forkMessages.length} fork point(s) available:`);
  for (const m of forkMessages.slice(0, 3)) {
    console.log(
      `  ${m.entryId.slice(0, 12)}… "${String(m.text).slice(0, 60).replace(/\n/g, " ")}"`,
    );
  }
  if (forkMessages.length > 3) console.log(`  … and ${forkMessages.length - 3} more`);
  console.log();

  // ── 19. getCommands — introspect Pi slash commands, skills, prompt templates ──
  section("19. getCommands — available slash commands");
  const commands = await agent.getCommands();
  console.log(`${commands.length} command(s) available:`);
  for (const cmd of commands.slice(0, 8)) {
    const desc = cmd.description ? ` — ${cmd.description.slice(0, 50)}` : "";
    console.log(`  /${cmd.name} [${cmd.source}]${desc}`);
  }
  if (commands.length > 8) console.log(`  … and ${commands.length - 8} more`);
  console.log();

  // ── 20. setSessionName ────────────────────────────────────────────────────────
  section("20. setSessionName — label the current session");
  await agent.setSessionName("pi-agent-example-run");
  console.log('setSessionName("pi-agent-example-run") → ok');
  const statsAfterRename = await agent.getSessionStats();
  console.log(`sessionId: ${statsAfterRename.sessionId} (name is metadata, id unchanged)\n`);

  // ── 21. setSteeringMode / setFollowUpMode ─────────────────────────────────────
  section("21. setSteeringMode + setFollowUpMode — queue processing modes");
  await agent.setSteeringMode("one-at-a-time");
  console.log('setSteeringMode("one-at-a-time") → ok');
  await agent.setSteeringMode("all");
  console.log('setSteeringMode("all")           → ok (restored)');
  await agent.setFollowUpMode("one-at-a-time");
  console.log('setFollowUpMode("one-at-a-time") → ok');
  await agent.setFollowUpMode("all");
  console.log('setFollowUpMode("all")           → ok (restored)\n');

  // ── 22. exportHtml — HTML transcript of the current session ──────────────────
  section("22. exportHtml — write HTML transcript to sandbox");
  const exported = await agent.exportHtml();
  console.log(`exportHtml() → ${exported.path}`);
  // Verify the file exists in the sandbox.
  const { stdout: htmlSize } = await agent.sandbox.exec(
    `wc -c < "${exported.path}" 2>/dev/null || echo 0`,
  );
  console.log(`file size: ${htmlSize.trim()} bytes\n`);

  // ── 23. event coverage — observe all new event types in a real stream ─────────
  // Run a short prompt and log every event type we see.
  // This exercises agent_start, turn_start, message_start, message_update,
  // message_end, turn_end, agent_end — all in a single short response.
  section("23. event coverage — observe all event types in raw stream");
  const seenTypes = new Set<string>();
  for await (const ev of agent.prompt("Reply with exactly: 'event coverage ok'")) {
    seenTypes.add(ev.type);
  }
  console.log(`Event types seen: ${[...seenTypes].sort().join(", ")}\n`);

  // ── 24. getLogs ───────────────────────────────────────────────────────────────
  section("24. getLogs — bridge ring-buffer (last 5 entries)");
  const logs = await agent.getLogs();
  const logLines = logs.trim().split("\n");
  console.log(`${logLines.length} log entries total. Last 5:`);
  for (const line of logLines.slice(-5)) console.log(" ", line);
  console.log();
} finally {
  await agent.close();
  console.log("Alineo closed.");
}
