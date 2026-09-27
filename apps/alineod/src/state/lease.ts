/**
 * The instance lease: one alineod per database, enforced rather than documented.
 *
 * Everything alineod keeps in memory — SSE fan-out (bus.ts), turn driving, notify delivery — is
 * process-local, and rehydrate claims every live agent on boot. Two instances on one database
 * would both drive the same agents, silently. So the database holds a single lease row with a
 * heartbeat, and a second instance refuses to start while the first is alive.
 *
 * A holder that died without releasing (`kill -9`, OOM, power loss) stops heartbeating, so a
 * booting instance waits up to one TTL for the lease to go stale and then takes it over. A
 * supervisor restarting a crashed alineod therefore boots up to `ttlMs` late, never loops.
 *
 * Scope: one host. The heartbeat is wall-clock, and SQLite on a shared network volume is
 * unsupported anyway (see the Scaling section of the deployment docs).
 */
import { hostname } from "node:os";
import { getLogger } from "@alineo-labs/logger";
import { db } from "./db";

const log = getLogger("alineod.lease");

db.exec(`
CREATE TABLE IF NOT EXISTS instance_lease (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- one row, ever
  instance_id   TEXT    NOT NULL,
  host          TEXT    NOT NULL,
  pid           INTEGER NOT NULL,
  acquired_at   INTEGER NOT NULL,                     -- epoch ms
  heartbeat_at  INTEGER NOT NULL                      -- epoch ms
);
`);

export interface LeaseHolder {
  instance_id: string;
  host: string;
  pid: number;
  acquired_at: number;
  heartbeat_at: number;
}

/** Another live instance holds the lease: it kept heartbeating for a full TTL while we waited. */
export class LeaseHeldError extends Error {
  constructor(public readonly holder: LeaseHolder) {
    super(
      `another alineod is running against this database (host ${holder.host}, pid ${holder.pid}, ` +
        `up since ${new Date(holder.acquired_at).toISOString()}). Run exactly one alineod per ` +
        `database: stop the other instance, or point this one at a different ALINEOD_DB_PATH.`,
    );
    this.name = "LeaseHeldError";
  }
}

export interface Lease {
  readonly instanceId: string;
  /** Stop heartbeating and delete the row, so the next boot doesn't wait out the TTL. */
  release(): void;
}

export interface AcquireLeaseOptions {
  ttlMs: number;
  /** Called once if another instance took the lease over while we held it. */
  onLost: (holder: LeaseHolder | null) => void;
}

const qHolder = db.query<LeaseHolder, []>(`SELECT * FROM instance_lease WHERE id = 1`);
const qClaim = db.query(
  `INSERT INTO instance_lease (id, instance_id, host, pid, acquired_at, heartbeat_at)
   VALUES (1, ?1, ?2, ?3, ?4, ?4)
   ON CONFLICT (id) DO UPDATE SET instance_id = ?1, host = ?2, pid = ?3,
                                  acquired_at = ?4, heartbeat_at = ?4`,
);
const qBeat = db.query(
  `UPDATE instance_lease SET heartbeat_at = ?2 WHERE id = 1 AND instance_id = ?1`,
);
const qRelease = db.query(`DELETE FROM instance_lease WHERE id = 1 AND instance_id = ?1`);

/**
 * Claim the lease if it is free, ours, or stale. Returns the live holder otherwise. IMMEDIATE, so
 * two instances booting at once can't both read "free" and both write.
 */
const tryClaim = db.transaction((instanceId: string, ttlMs: number): LeaseHolder | null => {
  const now = Date.now();
  const holder = qHolder.get();
  if (holder && holder.instance_id !== instanceId && now - holder.heartbeat_at < ttlMs) {
    return holder;
  }
  qClaim.run(instanceId, hostname(), process.pid, now);
  return null;
}).immediate;

export async function acquireLease(opts: AcquireLeaseOptions): Promise<Lease> {
  const instanceId = crypto.randomUUID();
  const beatMs = Math.max(1, Math.floor(opts.ttlMs / 3));
  const waitUntil = Date.now() + opts.ttlMs + beatMs;
  let warned = false;

  for (;;) {
    const holder = tryClaim(instanceId, opts.ttlMs);
    if (!holder) break;
    if (Date.now() >= waitUntil) throw new LeaseHeldError(holder);
    if (!warned) {
      log.warn("lease held by another instance; waiting to see whether it is still alive", {
        host: holder.host,
        pid: holder.pid,
        ageMs: Date.now() - holder.heartbeat_at,
        waitMs: waitUntil - Date.now(),
      });
      warned = true;
    }
    await Bun.sleep(beatMs);
  }
  log.info("lease acquired", { instanceId });

  let lost = false;
  const timer = setInterval(() => {
    try {
      if (qBeat.run(instanceId, Date.now()).changes === 0 && !lost) {
        lost = true;
        clearInterval(timer);
        opts.onLost(qHolder.get());
      }
    } catch (err) {
      // SQLITE_BUSY while a booting contender holds its brief write lock. Skip this beat; the
      // TTL is three beats long, so one miss can't make the lease look stale.
      log.warn("lease heartbeat skipped", { error: err instanceof Error ? err.message : err });
    }
  }, beatMs);
  timer.unref();

  return {
    instanceId,
    release() {
      clearInterval(timer);
      qRelease.run(instanceId);
    },
  };
}
