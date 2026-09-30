/**
 * Backpressure on provisioning (admission-control.md, baseline attribute #3): a global cap on
 * concurrent `Alineo.start()`/`parent.spawn()` calls. This alineod instance's own vCPUs are the
 * real constraint an incident already found — `central-config.md`: "four concurrent forks on one
 * vCPU left an agent unprovisioned after 325s". Scope: provisioning only (cold-fork,
 * CPU/IO-heavy, ~10-70s measured) — a running agent driving a turn doesn't contend for this.
 *
 * Composes with `fork-lock.ts`, does not replace it: this caps concurrency GLOBALLY across every
 * parent; `fork-lock.ts` separately still serializes two forks against the SAME parent once each
 * has its slot here.
 *
 * Not a rejection (429/409) — a hold, the same shape as `waitFor`'s hold-then-spawn
 * (`spawn.ts`/`waitfor.ts`). An agent's own `alineo fork` call, issued mid-reasoning from inside
 * a running turn, has no sensible way to interpret or retry an HTTP error triggered by *someone
 * else's* concurrent provisioning load.
 */
import { emit } from "./emit";
import { sleep } from "../util";
import { ADMISSION_CONCURRENCY, ADMISSION_TIMEOUT_MS } from "../../config";

let inUse = 0;

interface Waiter {
  grant: () => void;
}
const waiters: Waiter[] = [];

function tryAcquire(): boolean {
  if (inUse < ADMISSION_CONCURRENCY) {
    inUse++;
    return true;
  }
  return false;
}

/** Hands the freed slot straight to the next waiter (inUse unchanged), or actually frees it. */
function release(): void {
  const next = waiters.shift();
  if (next) {
    next.grant();
  } else {
    inUse--;
  }
}

export type AdmissionOutcome = "granted" | "timeout";

export interface AdmissionResult {
  outcome: AdmissionOutcome;
  /** Call once provisioning finishes (success or failure) — always, in a `finally`. No-op on timeout. */
  release: () => void;
}

/**
 * Acquire a provisioning slot for `agentId`, holding (bounded by `ALINEOD_ADMISSION_TIMEOUT_MS`)
 * if none is free right now. Emits `agent.admission_queued`/`_granted`/`_timeout` only when a
 * real wait happens — the common uncontended path is silent by design, so the ledger stays a
 * signal for genuinely stuck spawns rather than noise on every spawn.
 */
export async function acquireAdmission(runId: string, agentId: string): Promise<AdmissionResult> {
  if (tryAcquire()) return { outcome: "granted", release };

  emit(runId, agentId, "agent.admission_queued", { capacity: ADMISSION_CONCURRENCY });

  const waiter: Waiter = { grant: () => {} };
  const granted = new Promise<void>((resolve) => {
    waiter.grant = resolve;
  });
  waiters.push(waiter);

  const timedOut = await Promise.race([
    granted.then(() => false),
    sleep(ADMISSION_TIMEOUT_MS).then(() => true),
  ]);

  if (timedOut) {
    const idx = waiters.indexOf(waiter);
    if (idx !== -1) {
      // Genuinely still queued — remove it and report the timeout. No slot was ever acquired,
      // so there is nothing to release.
      waiters.splice(idx, 1);
      emit(runId, agentId, "agent.admission_timeout", { waitedMs: ADMISSION_TIMEOUT_MS });
      return { outcome: "timeout", release: () => {} };
    }
    // `release()` already shifted this waiter out and granted it in the same tick the timeout
    // fired — the slot is real. Fall through and report it granted rather than leaking it.
  }

  emit(runId, agentId, "agent.admission_granted", {});
  return { outcome: "granted", release };
}
