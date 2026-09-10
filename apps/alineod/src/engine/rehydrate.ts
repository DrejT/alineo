/**
 * Crash-only recovery (research/daemon.md §3). On boot:
 *   1. rebuild the `agents` / `handles` projections from the ledger
 *   2. for every agent still in a live state, reconnect to its sandbox
 *   3. anything whose sandbox is gone → `agent_ended { outcome: "lost" }`
 *
 * D-a: `Alineo.resume()` kills and restarts the in-sandbox bridge — not ideal, it drops any
 * in-flight turn. The real fix is an SDK "attach from the control plane" path that rebinds
 * the bridge SSE without a bridge restart. For the prototype, resume is acceptable.
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
    try {
      const agent = await Alineo.resume(a.sandbox_id, {
        adapter: sdkAdapter,
        spec: JSON.parse(a.spec_json),
        runId: a.run_id,
      });
      register(a.agent_id, agent);
      console.log(`[alineod]   reattached ${a.agent_id} (${a.sandbox_id})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(a.run_id, a.agent_id, "agent_ended", { outcome: "lost", endedAt: Date.now(), error: message });
      console.log(`[alineod]   lost ${a.agent_id}: ${message}`);
    }
  }
}
