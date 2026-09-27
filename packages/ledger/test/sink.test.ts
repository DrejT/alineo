import { describe, expect, it, vi } from "vitest";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import { composeSinks, jsonlSink, memorySink } from "../src/index";

const envelope = (type: string, ts = 1): LedgerEnvelope => ({ v: 1, ts, type, data: {} });

describe("composeSinks", () => {
  it("fans out to every sink in order", () => {
    const a = memorySink();
    const b = memorySink();
    composeSinks([a, b])(envelope("agent.spawned"));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("isolates a throwing sink so its siblings still run", () => {
    // The whole reason sinks are composed rather than called in a loop by the emitter: one
    // broken exporter must not take out the others, or the operation that emitted the event.
    const after = memorySink();
    const onError = vi.fn();
    const sink = composeSinks(
      [
        () => {
          throw new Error("exporter down");
        },
        after,
      ],
      onError,
    );
    expect(() => sink(envelope("agent.spawned"))).not.toThrow();
    expect(after.events).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("survives an onError that itself throws", () => {
    // A reporting callback that throws would reintroduce the exact failure composeSinks
    // exists to prevent, one level up.
    const after = memorySink();
    const sink = composeSinks(
      [
        () => {
          throw new Error("exporter down");
        },
        after,
      ],
      () => {
        throw new Error("and the logger is down too");
      },
    );
    expect(() => sink(envelope("agent.spawned"))).not.toThrow();
    expect(after.events).toHaveLength(1);
  });

  it("passes the failing envelope to onError, not just the error", () => {
    const onError = vi.fn();
    composeSinks(
      [
        () => {
          throw new Error("nope");
        },
      ],
      onError,
    )(envelope("exec.completed", 7));
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ type: "exec.completed", ts: 7 });
  });
});

describe("memorySink", () => {
  it("keeps emission order and clears", () => {
    const sink = memorySink();
    sink(envelope("a.started", 1));
    sink(envelope("b.started", 2));
    expect(sink.events.map((e) => e.type)).toEqual(["a.started", "b.started"]);
    sink.clear();
    expect(sink.events).toHaveLength(0);
  });
});

describe("jsonlSink", () => {
  it("writes one newline-terminated JSON object per event", () => {
    const lines: string[] = [];
    const sink = jsonlSink((line) => lines.push(line));
    sink(envelope("agent.spawned"));
    sink(envelope("agent.ended"));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "agent.spawned", v: 1 });
  });
});
