/**
 * Crash-only recovery (research/daemon.md §3). On boot:
 *   1. rebuild the `agents` / `handles` projections from the ledger
 *   2. for every agent still in a live state, reconnect to its sandbox
 *   3. anything whose sandbox is gone → `agent_ended { outcome: "lost" }`
 *
 * D-a (resolved 2026-09-11): try `Alineo.reattach()` first — it rebinds to the bridge process
 * already running inside the sandbox without touching it, so an in-flight turn survives an
 * alineod restart. Only if that fails (the bridge genuinely isn't there — e.g. the whole
 * sandbox actually restarted, not just this process) fall back to `Alineo.resume()`, which
 * kills and restarts the bridge and does drop whatever was in flight.
 */
import { Alineo } from "alineo";
import { rebuild, liveAgents } from "../state/projection";
import { sdkAdapter, register } from "./registry";
import { emit } from "./emit";

export async function rehydrate(): Promise<void> {
  rebuild();

  const live = liveAgents();
  if (live.length === 0) return;

  console.log(`[alineod] rehydrating ${live.length} live agent(s)...`);
  for (const a of live) {
    if (!a.sandbox_id) {
      emit(a.run_id, a.agent_id, "agent_ended", { outcome: "lost", endedAt: Date.now(), error: "no sandbox id" });
      continue;
    }
    const spec = JSON.parse(a.spec_json);
    const opts = { adapter: sdkAdapter, spec, runId: a.run_id };

    try {
      const agent = await Alineo.reattach(a.sandbox_id, opts);
      register(a.agent_id, agent);
      console.log(`[alineod]   reattached ${a.agent_id} (${a.sandbox_id}) — bridge preserved`);
      continue;
    } catch (reattachErr) {
      console.log(
        `[alineod]   reattach failed for ${a.agent_id} (${describeError(reattachErr)}) — falling back to resume`,
      );
    }

    try {
      const agent = await Alineo.resume(a.sandbox_id, opts);
      register(a.agent_id, agent);
      console.log(`[alineod]   resumed ${a.agent_id} (${a.sandbox_id}) — bridge restarted`);
    } catch (err) {
      const message = describeError(err);
      emit(a.run_id, a.agent_id, "agent_ended", { outcome: "lost", endedAt: Date.now(), error: message });
      console.log(`[alineod]   lost ${a.agent_id}: ${message}`);
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
