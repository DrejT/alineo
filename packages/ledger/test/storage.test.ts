import { describe, expect, it } from "vitest";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import { byAggregate, fold, inLedgerOrder, MemoryStorage, persistedOnly } from "../src/index";

const envelope = (type: string, runId?: string, ts = 1): LedgerEnvelope => ({
  v: 1,
  ts,
  type,
  runId,
  data: {},
});

describe("MemoryStorage", () => {
  it("assigns seq per aggregate, starting at 1", () => {
    const store = new MemoryStorage();
    expect(store.append(envelope("run.started", "r1")).durable.seq).toBe(1);
    expect(store.append(envelope("agent.spawned", "r1")).durable.seq).toBe(2);
    // A second aggregate counts independently — seq is scoped, not global, because a monotone
    // sequence needs a single writer and there is one per aggregate, not one overall.
    expect(store.append(envelope("run.started", "r2")).durable.seq).toBe(1);
  });

  it("reads back in seq order", () => {
    const store = new MemoryStorage();
    store.append(envelope("run.started", "r1"));
    store.append(envelope("agent.spawned", "r1"));
    store.append(envelope("agent.ended", "r1"));
    expect(store.read("r1").map((e) => e.durable.seq)).toEqual([1, 2, 3]);
  });

  it("readSince returns strictly after the given seq — the SSE reconnect contract", () => {
    const store = new MemoryStorage();
    for (const type of ["run.started", "agent.spawned", "agent.ended"]) {
      store.append(envelope(type, "r1"));
    }
    expect(store.readSince("r1", 1).map((e) => e.type)).toEqual(["agent.spawned", "agent.ended"]);
    expect(store.readSince("r1", 3)).toEqual([]);
  });

  it("returns an empty list for an unknown aggregate rather than throwing", () => {
    expect(new MemoryStorage().read("never-existed")).toEqual([]);
  });

  it("refuses an event it cannot place", () => {
    // Silently dropping it, or filing it under "undefined", would lose the event — and a lost
    // event is a projection that never rebuilds correctly.
    expect(() => new MemoryStorage().append(envelope("agent.spawned"))).toThrow(/no aggregate/);
  });

  it("does not hand out its own array", () => {
    const store = new MemoryStorage();
    store.append(envelope("run.started", "r1"));
    store.read("r1").push(store.read("r1")[0]!);
    expect(store.read("r1")).toHaveLength(1);
  });
});

describe("fold helpers", () => {
  it("folds a stream into a projection", () => {
    const store = new MemoryStorage();
    store.append(envelope("agent.spawned", "r1"));
    store.append(envelope("agent.spawned", "r1"));
    store.append(envelope("agent.ended", "r1"));
    const live = fold(store.read("r1"), 0, (n, e) =>
      e.type === "agent.spawned" ? n + 1 : e.type === "agent.ended" ? n - 1 : n,
    );
    expect(live).toBe(1);
  });

  it("orders by seq within an aggregate and by ts across them", () => {
    const store = new MemoryStorage();
    const a2 = store.append(envelope("agent.ended", "r1", 50));
    const a1 = store.append(envelope("agent.spawned", "r1", 10));
    const b = store.append(envelope("run.started", "r2", 30));
    // a1 has the later seq despite the earlier ts, and stays after a2 — within one aggregate
    // the sequence is the truth, not the clock.
    expect(inLedgerOrder([b, a1, a2]).map((e) => e.durable?.seq)).toEqual([1, 2, 1]);
  });

  it("drops stream-only events from a rebuild", () => {
    const store = new MemoryStorage();
    const durable = store.append(envelope("agent.spawned", "r1"));
    expect(persistedOnly([durable, envelope("message.updated", "r1")])).toEqual([durable]);
  });

  it("groups by aggregate and ignores events that have none", () => {
    const store = new MemoryStorage();
    store.append(envelope("run.started", "r1"));
    store.append(envelope("run.started", "r2"));
    const groups = byAggregate([
      ...store.read("r1"),
      ...store.read("r2"),
      envelope("message.updated", "r1"),
    ]);
    expect([...groups.keys()].sort()).toEqual(["r1", "r2"]);
    expect(groups.get("r1")).toHaveLength(1);
  });
});
