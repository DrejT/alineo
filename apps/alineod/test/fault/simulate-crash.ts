/**
 * Fault injection: "the alineod process dies" (durability-roadmap M0.3's first scenario, `kill
 * -9`). Drops exactly what a real process death drops — open sandbox connections and in-flight
 * turn tracking — without touching the ledger, the same distinction `rehydrate.ts`'s own doc
 * comment draws between durable truth and process-local state.
 *
 * Deliberately NOT a real subprocess kill: alineod's fake-SDK test harness (`../fakes.ts`,
 * `../setup.ts`) is installed via `bun:test`'s `mock.module`, which only exists inside this
 * process's test runtime — a genuine `Bun.spawn` + `SIGKILL` child process would need its own,
 * separately-installed fake SDK (or a real OpenSandbox server) to boot at all. The in-process
 * simulation below is what `rehydrate.test.ts` already does per-test with hand-seeded ledger
 * rows; this reuses the same idea against a REAL swarm reached through the real routes, which is
 * what the fault harness adds over that file's more granular unit tests.
 */
import { forgetAllForFaultInjection } from "../../src/engine/registry";
import { forgetAllTurnTrackingForFaultInjection } from "../../src/engine/stream";
import { rehydrate } from "../../src/engine/rehydrate";

/**
 * Simulate alineod dying right now, then boot a fresh instance against the same (untouched)
 * ledger. Known simplification: a few other module-level in-memory caches (fork-lock.ts's
 * per-parent queues, notify.ts's delivery chains, quiescence.ts's last-seen map) are not reset —
 * their entries are either self-cleaning resolved promises or re-derived from the projection on
 * next read, so a stale entry is inert, not incorrect. Extend this if a future scenario finds
 * otherwise.
 */
export async function simulateCrashAndRehydrate(): Promise<void> {
  forgetAllForFaultInjection();
  forgetAllTurnTrackingForFaultInjection();
  await rehydrate();
}
