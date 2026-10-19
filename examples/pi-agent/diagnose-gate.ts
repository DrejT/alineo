/**
 * Diagnose a permission gate that raised nothing.
 *
 * When `test-harness-live.ts` or the human-in-the-loop test fails with "no permission_request",
 * there are two causes that look the same: the gate did not fire, or the model never called a
 * tool. This starts one agent with `permissions: "ask"`, sends the same prompt several times, and
 * prints for each turn what the model actually did: its tool calls, the permission requests, the
 * text, and the turn's stop reason and error. A turn with no tool call and a stop reason of
 * "error" is the model or the provider, not the gate.
 *
 * Run:  bun examples/pi-agent/diagnose-gate.ts   (from examples/pi-agent)
 * Needs: OpenSandbox running and NVIDIA_API_KEY in the environment.
 * Optional: TRIES=5 PI_VERSION=1.2.0 MODEL=nvidia/nemotron-3-super-120b-a12b
 */
import { Alineo, type AgentEvent } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const spec = (await Bun.file("./agents/hello-agent.json").json()) as Record<string, unknown>;
if (process.env.PI_VERSION) spec.harness = { id: "pi", version: process.env.PI_VERSION };
if (process.env.MODEL) spec.model = process.env.MODEL;
const tries = Number(process.env.TRIES ?? 5);

const agent = await Alineo.start(
  { ...spec, name: `diagnose-gate-${Date.now()}`, permissions: "ask" } as never,
  { adapter: new SQLiteAdapter(":memory:") },
);

let requested = 0;
try {
  for (let i = 1; i <= tries; i++) {
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const ev of agent.prompt(
      "Use the bash tool to run: echo gate-test. Then say done.",
      {
        onPermission: () => ({ kind: "reject", feedback: "not allowed in this test" }),
      },
    )) {
      events.push(ev);
    }
    const tools = events
      .filter((e) => e.type === "tool_start")
      .map((e) => (e as { toolName: string }).toolName);
    const asked = events.filter((e) => e.type === "permission_request").length;
    requested += asked > 0 ? 1 : 0;
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { text: string }).text)
      .join("")
      .slice(0, 100);
    const end = events.findLast((e) => e.type === "turn_end") as
      | { message?: { stopReason?: string; errorMessage?: string } }
      | undefined;
    console.log(
      `#${i} ${Date.now() - started}ms tools=[${tools}] permission_requests=${asked} ` +
        `stop=${end?.message?.stopReason ?? "?"} error=${JSON.stringify(end?.message?.errorMessage ?? null)} ` +
        `text=${JSON.stringify(text)}`,
    );
  }
} finally {
  await agent.close().catch(() => {});
}
console.log(`\nthe gate raised a request in ${requested} of ${tries} turns`);
