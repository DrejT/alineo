/**
 * Diagnose a turn that ended as a success with no text.
 *
 * alineod once recorded the first prompt of a run as `success` after 0.5 s with an empty
 * result. A turn can end like that for three reasons: the model API refused the request (Pi
 * reports `stopReason: "error"`, which alineod now treats as a failure), the model returned an
 * empty completion (`stopReason: "stop"` and no content), or the prompt never reached the model.
 * This sends one prompt many times to a fresh agent and prints, for each turn, how long it took
 * and what the last assistant message holds, so the three can be told apart and counted.
 *
 * Run:  bun examples/pi-agent/diagnose-empty-turn.ts   (from examples/pi-agent)
 * Needs: OpenSandbox running and NVIDIA_API_KEY in the environment.
 * Optional: TRIES=20 PI_VERSION=1.2.0 MODEL=nvidia/nemotron-3-super-120b-a12b
 */
import { Alineo, type AgentEvent } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const spec = (await Bun.file("./agents/hello-agent.json").json()) as Record<string, unknown>;
if (process.env.PI_VERSION) spec.harness = { id: "pi", version: process.env.PI_VERSION };
if (process.env.MODEL) spec.model = process.env.MODEL;
const tries = Number(process.env.TRIES ?? 20);

const agent = await Alineo.start({ ...spec, name: `diagnose-empty-${Date.now()}` } as never, {
  adapter: new SQLiteAdapter(":memory:"),
});

let empty = 0;
let errored = 0;
try {
  for (let i = 1; i <= tries; i++) {
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const ev of agent.prompt("Reply with exactly the word READY and nothing else.")) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { text: string }).text)
      .join("")
      .trim();
    const end = events.findLast((e) => e.type === "turn_end") as
      | { message?: { stopReason?: string; errorMessage?: string; content?: unknown[] } }
      | undefined;
    const message = end?.message;
    if (text === "") empty++;
    if (message?.stopReason === "error") errored++;
    console.log(
      `#${i} ${Date.now() - started}ms text=${JSON.stringify(text.slice(0, 40))} ` +
        `stop=${message?.stopReason ?? "?"} content_blocks=${message?.content?.length ?? "?"} ` +
        `error=${JSON.stringify(message?.errorMessage ?? null)} events=${events.length}`,
    );
  }
} finally {
  await agent.close().catch(() => {});
}
console.log(
  `\n${empty} of ${tries} turns had no text; ${errored} of them ended with stopReason "error"`,
);
