/**
 * Generalizes spawn's idempotency (`spawn_idempotency`, D-f, `spawn.ts`) to pause/resume/stop/
 * steer: `command_idempotency` (db.ts) holds the same reserve -> act -> record shape for any
 * command with a client-supplied key, scoped by (agentId, command, key) instead of (runId, key)
 * since these act on an existing agent rather than minting one.
 *
 * Reserve is a single atomic `INSERT ... ON CONFLICT DO NOTHING`, so it is safe even for `steer`,
 * which does NOT run under agent-lock.ts's per-agent queue. For pause/resume/stop, which DO, a
 * genuinely concurrent 'pending' hit below is unreachable in practice — agent-lock.ts already
 * guarantees no second call's body starts until the first one's has fully finished and recorded
 * its outcome — but the same bounded-wait path below handles it correctly regardless, rather than
 * assuming it can't happen.
 */
import { completeIdempotentCommand, reserveIdempotentCommand } from "../state/db";
import { HttpError } from "./errors";
import { sleep } from "../util";

// A 'pending' hit only matters for steer (see above), and `agent.steer()` is a fast fire-and-
// forget ack, not a multi-second sandbox operation — 1s total is generous headroom, not a
// measured number (open decision in idempotent-commands.md).
const PENDING_POLL_MS = 100;
const PENDING_POLL_ATTEMPTS = 10;

interface StoredFailure {
  status: number;
  error: string;
}

/**
 * Run `act()` under idempotency key `key` for `command` on `agentId` — or skip the whole
 * mechanism and just run it when no key is given (state-transition idempotence, handled by each
 * command's own no-op check, still applies with no key at all).
 */
export async function withIdempotency<T>(
  agentId: string,
  command: string,
  key: string | undefined,
  act: () => Promise<T>,
): Promise<T> {
  if (!key) return act();

  const reservation = await resolveReservation(agentId, command, key);
  if (reservation.kind === "replay") {
    if (reservation.status === "failed") {
      const f = reservation.response as StoredFailure;
      throw new HttpError(f.status, f.error);
    }
    return reservation.response as T;
  }

  try {
    const result = await act();
    // db.ts's completeIdempotentCommand already null-coalesces before stringifying.
    completeIdempotentCommand(agentId, command, key, "completed", result);
    return result;
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const error = err instanceof Error ? err.message : String(err);
    completeIdempotentCommand(agentId, command, key, "failed", { status, error } satisfies StoredFailure);
    throw err;
  }
}

type Reservation =
  | { kind: "won" }
  | { kind: "replay"; status: "completed" | "failed"; response: unknown };

async function resolveReservation(
  agentId: string,
  command: string,
  key: string,
): Promise<Reservation> {
  for (let attempt = 0; attempt < PENDING_POLL_ATTEMPTS; attempt++) {
    const reservation = reserveIdempotentCommand(agentId, command, key);
    if (reservation.won) return { kind: "won" };
    if (reservation.status !== "pending") {
      return { kind: "replay", status: reservation.status, response: reservation.response };
    }
    await sleep(PENDING_POLL_MS);
  }
  throw new HttpError(
    409,
    `a request with idempotency key "${key}" for ${command} on ${agentId} is still in flight`,
  );
}
