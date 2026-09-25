/** The instance lease: one alineod per database. */
import { afterEach, expect, test } from "bun:test";
import { db } from "../src/state/db";
import { acquireLease, LeaseHeldError, type LeaseHolder } from "../src/state/lease";

const TTL = 300;

function holder(): LeaseHolder | null {
  return db.query<LeaseHolder, []>(`SELECT * FROM instance_lease WHERE id = 1`).get();
}

/** Pretend another process holds the lease, last seen `ageMs` ago. */
function foreignLease(ageMs: number): void {
  const at = Date.now() - ageMs;
  db.query(
    `INSERT OR REPLACE INTO instance_lease (id, instance_id, host, pid, acquired_at, heartbeat_at)
     VALUES (1, 'other', 'other-host', 4242, ?1, ?1)`,
  ).run(at);
}

function beat(): void {
  db.query(`UPDATE instance_lease SET heartbeat_at = ? WHERE instance_id = 'other'`).run(
    Date.now(),
  );
}

afterEach(() => {
  db.exec(`DELETE FROM instance_lease`);
});

test("claims a free lease, and release deletes it", async () => {
  const lease = await acquireLease({ ttlMs: TTL, onLost: () => {} });
  expect(holder()?.instance_id).toBe(lease.instanceId);
  expect(holder()?.pid).toBe(process.pid);

  lease.release();
  expect(holder()).toBeNull();
});

test("takes over a stale lease immediately — a crashed holder never blocks a restart for long", async () => {
  foreignLease(TTL * 2);
  const started = Date.now();
  const lease = await acquireLease({ ttlMs: TTL, onLost: () => {} });

  expect(holder()?.instance_id).toBe(lease.instanceId);
  expect(Date.now() - started).toBeLessThan(TTL);
  lease.release();
});

test("refuses to start while another instance keeps heartbeating", async () => {
  foreignLease(0);
  const alive = setInterval(beat, TTL / 4);
  try {
    const err = await acquireLease({ ttlMs: TTL, onLost: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseHeldError);
    expect((err as LeaseHeldError).message).toContain("other-host");
    expect((err as LeaseHeldError).message).toContain("one alineod per");
    expect(holder()?.instance_id).toBe("other");
  } finally {
    clearInterval(alive);
  }
});

test("waits out a fresh lease whose holder has died, then takes it over", async () => {
  foreignLease(0); // fresh, but nobody will ever beat it again — the kill -9 case
  const started = Date.now();
  const lease = await acquireLease({ ttlMs: TTL, onLost: () => {} });

  expect(holder()?.instance_id).toBe(lease.instanceId);
  expect(Date.now() - started).toBeGreaterThanOrEqual(TTL - 50);
  lease.release();
});

test("reports a lost lease once, with the new holder", async () => {
  const lost: (LeaseHolder | null)[] = [];
  const lease = await acquireLease({ ttlMs: TTL, onLost: (h) => lost.push(h) });

  foreignLease(0); // someone overwrote our row
  await Bun.sleep(TTL);

  expect(lost).toHaveLength(1);
  expect(lost[0]?.instance_id).toBe("other");
  lease.release(); // not ours any more — must not delete the other instance's row
  expect(holder()?.instance_id).toBe("other");
});
