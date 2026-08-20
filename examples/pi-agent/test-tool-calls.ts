/**
 * Tool call observability test — verifies that agent.prompt() surfaces
 * tool_start / tool_update / tool_end events when Pi uses bash or file tools.
 *
 * Run:  bun examples/pi-agent/test-tool-calls.ts
 * Needs: OpenSandbox running (uvx opensandbox-server) and NVIDIA_API_KEY in .env
 *
 * Expected output:
 *   - At least one tool_start event (Pi will run bash to execute the script)
 *   - A tool_end event for each tool_start
 *   - The final text answer from Pi
 */
import { Alineo, textOnly, type AgentEvent } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const SPEC = "./agents/hello-agent.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");

const agent = await Alineo.load(SPEC, { adapter });
console.log(
  `\nSandbox: ${agent.sandboxId}  fromSnapshot=${agent.fromSnapshot}\n${"─".repeat(60)}\n`,
);

// Write a small Python script for Pi to discover and run.
await agent.sandbox.writeFile(
  "/workspace/greet.py",
  'name = "alineo"\nprint(f"Hello from {name}! 2 + 2 = {2 + 2}")\n',
);

// ── Run a prompt that forces Pi to use tools ──────────────────────────────────
// Asking Pi to run a file guarantees at least one bash tool call.
const prompt =
  "There is a Python script at /workspace/greet.py. " +
  "Run it with python3 and tell me exactly what it printed.";

console.log(`Prompt: "${prompt}"\n`);

const toolEvents: AgentEvent[] = [];
let textOutput = "";

for await (const ev of agent.prompt(prompt)) {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      textOutput += ev.text;
      break;

    case "tool_start":
      console.log(`\n[tool_start]  ${ev.toolName}  args=${JSON.stringify(ev.args)}`);
      toolEvents.push(ev);
      break;

    case "tool_update":
      // Partial output from a long-running tool — just log the tool name.
      process.stdout.write(`[tool_update: ${ev.toolName}]`);
      toolEvents.push(ev);
      break;

    case "tool_end":
      console.log(
        `[tool_end]    ${ev.toolName}  isError=${ev.isError}  ` +
          `result=${JSON.stringify(ev.result).slice(0, 120)}`,
      );
      toolEvents.push(ev);
      break;
  }
}

console.log("\n\n" + "─".repeat(60));
console.log("=== Summary ===\n");

const starts = toolEvents.filter((e) => e.type === "tool_start");
const ends = toolEvents.filter((e) => e.type === "tool_end");
const updates = toolEvents.filter((e) => e.type === "tool_update");

console.log(`tool_start  events: ${starts.length}`);
console.log(`tool_update events: ${updates.length}`);
console.log(`tool_end    events: ${ends.length}`);
console.log(`text output length: ${textOutput.length} chars`);

// Tool names seen
const toolNames = [
  ...new Set(starts.map((e) => (e as Extract<AgentEvent, { type: "tool_start" }>).toolName)),
];
console.log(`tools used: ${toolNames.join(", ") || "(none)"}`);

if (starts.length > 0 && ends.length > 0 && textOutput.length > 0) {
  console.log("\n✓ Tool call observability working");
} else if (starts.length === 0) {
  console.log(
    "\n✗ No tool_start events received — Pi may have answered without using tools.",
    "\n  Try a prompt that forces a bash call, e.g. running a file.",
  );
} else {
  console.log("\n✗ Unexpected state — check the output above.");
}

await agent.close();
console.log("Alineo closed.");
