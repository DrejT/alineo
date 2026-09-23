/**
 * Which NVIDIA NIM models can actually drive a turn through the Pi bridge?
 *
 * The answer keeps changing and keeps mattering — models reach end-of-life, and one that
 * answers `/v1/chat/completions` in a second can still be unusable here, because a reasoning
 * model that streams nothing while it thinks trips alineod's `PROMPT_INACTIVITY_TIMEOUT_MS`
 * (180s by default) before it ever emits a token. A plain `curl` at the API cannot see that;
 * only a real sandbox with a real bridge can.
 *
 * Run several samples: the failure mode is intermittent, and one green run proves nothing.
 *
 *   NVIDIA_API_KEY=… bun apps/alineod/scripts/probe-models.ts \
 *     nvidia/nemotron-3-super-120b-a12b nvidia/nemotron-3.5-lightning-30b-a3b
 *
 * Needs OpenSandbox running (`alineo init`). Each sample costs ~25s of sandbox start plus the
 * turn itself, so this is a minutes-long script by nature.
 */
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const SAMPLES = Number(process.env.SAMPLES ?? 3);
const models = process.argv.slice(2);
if (models.length === 0) {
  throw new Error("usage: bun apps/alineod/scripts/probe-models.ts <model> [model…]");
}
if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is required");

for (const model of models) {
  console.log(`\n${model}`);
  for (let i = 1; i <= SAMPLES; i++) {
    const spec = {
      name: `probe-${model.split("/")[1]!.slice(0, 24)}-${i}`,
      harness: "pi",
      provider: "nvidia",
      model,
      env: { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY },
      resources: { cpu: "1000m", memory: "2Gi" },
    };
    let agent: Alineo | undefined;
    try {
      agent = await Alineo.start(spec, { adapter: new SQLiteAdapter(":memory:") });
      const started = Date.now();
      let text = "";
      // One word, so the time below is the model's floor, not the task's.
      for await (const chunk of textOnly(agent.prompt("Reply with exactly: OK"))) text += chunk;
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        text.trim().length > 0
          ? `  ${i}. ${seconds}s → ${JSON.stringify(text.trim().slice(0, 60))}`
          : `  ${i}. ${seconds}s → EMPTY (upstream ended the turn early)`,
      );
    } catch (err) {
      console.log(`  ${i}. FAILED: ${(err as Error).message.slice(0, 160)}`);
    } finally {
      await agent?.close();
    }
  }
}
