/**
 * Human-in-the-loop — `AgentSpec.permissions` + `agent.resolvePermission()`.
 *
 * The spec (agents/hitl-agent.json) sets a permission policy: read-only tools run freely,
 * `rm -rf` is hard-denied, and everything else pauses for approval. Each paused call
 * surfaces as a `permission_request` event on the stream; this script plays the operator,
 * approving or rejecting from the terminal.
 *
 * Run:  cd examples/human-in-the-loop && bun index.ts
 * Needs: OpenSandbox running (alineo init) and NVIDIA_API_KEY in your environment.
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { createInterface } from "node:readline/promises";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const spec = await Bun.file("./agents/hitl-agent.json").json();
const agent = await Alineo.load(spec, { adapter });
console.log(`\nSandbox: ${agent.sandboxId}\n${"─".repeat(60)}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Ask the human what to do about one gated tool call. */
async function decide(tool: string, target: string) {
  console.log(`\n⏸  Approval needed — ${tool}\n    ${target}`);
  const answer = (await rl.question("    [a]llow once · [A]lways · [d]eny · [f]eedback? ")).trim();
  if (answer === "a") return { kind: "once" } as const;
  if (answer === "A") return { kind: "always" } as const;
  if (answer === "f") {
    const feedback = await rl.question("    what should it do instead? ");
    return { kind: "reject", feedback } as const;
  }
  return { kind: "reject" } as const;
}

try {
  const stream = agent.prompt(
    "Create a Python script hello.py that prints the current date, then run it. " +
      "Then try to clean up by running: rm -rf /tmp/nonexistent-dir",
  );

  for await (const ev of stream) {
    if (ev.type === "text") {
      process.stdout.write(ev.text);
    } else if (ev.type === "tool_start") {
      console.log(`\n  ▶ ${ev.toolName}`);
    } else if (ev.type === "permission_request") {
      const decision = await decide(ev.tool, ev.target);
      await agent.resolvePermission(ev.requestId, decision);
    } else if (ev.type === "permission_resolved") {
      console.log(`    → ${ev.decision.kind === "reject" ? "denied" : "approved"}`);
    }
  }
  console.log("\n");
} finally {
  rl.close();
  await agent.close();
  console.log("Alineo closed.");
}
