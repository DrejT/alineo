import { describe, expect, it } from "vitest";
import type { ExecChannel, ExecEvent } from "@alineo-labs/provider";
import { LineEndingRepair, withLineEndingRepair } from "../src/line-endings.ts";

const out = (text: string): ExecEvent => ({ type: "stdout", text, timestamp: 0 });
const err = (text: string): ExecEvent => ({ type: "stderr", text, timestamp: 0 });
const done = (): ExecEvent => ({ type: "execution_complete", timestamp: 0 });
const exit = (code = 0): ExecEvent => ({
  type: "error",
  error: { evalue: String(code) },
  timestamp: 0,
});

// eslint-disable-next-line typescript/require-await -- an async generator by signature
async function* stream(events: ExecEvent[]): AsyncGenerator<ExecEvent> {
  for (const ev of events) yield ev;
}

async function run(repair: LineEndingRepair, events: ExecEvent[]): Promise<ExecEvent[]> {
  const seen: ExecEvent[] = [];
  for await (const ev of repair.repair(stream(events))) seen.push(ev);
  return seen;
}

const texts = (events: ExecEvent[], type = "stdout") =>
  events.filter((e) => e.type === type).map((e) => e.text);

describe("LineEndingRepair: a server that drops endings", () => {
  it("restores them when every output event is a bare line", async () => {
    const events = await run(new LineEndingRepair(), [
      out("one"),
      out("two"),
      out("three"),
      exit(),
    ]);
    expect(texts(events)).toEqual(["one\n", "two\n", "three\n"]);
  });

  it("keeps the terminal event last, after the repaired output", async () => {
    const events = await run(new LineEndingRepair(), [out("a"), out("b"), exit(3)]);
    expect(events.map((e) => e.type)).toEqual(["stdout", "stdout", "error"]);
  });

  it("repairs stderr by the same rule, separately from stdout", async () => {
    const events = await run(new LineEndingRepair(), [out("only"), err("e1"), err("e2"), exit(1)]);
    expect(texts(events)).toEqual(["only"]);
    expect(texts(events, "stderr")).toEqual(["e1\n", "e2\n"]);
  });

  it("does not hold output once it has learned, so a long command still streams", async () => {
    const repair = new LineEndingRepair();
    await run(repair, [out("a"), out("b"), exit()]);

    // A second stream: the first event must come out before the stream is finished.
    const received: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // eslint-disable-next-line typescript/require-await -- an async generator by signature
    async function* slow(): AsyncGenerator<ExecEvent> {
      yield out("first");
      await gate;
      yield out("second");
      yield exit();
    }
    const consumer = (async () => {
      for await (const ev of repair.repair(slow())) {
        if (ev.type === "stdout") received.push(ev.text ?? "");
        if (received.length === 1) release();
      }
    })();
    await consumer;

    expect(received).toEqual(["first\n", "second\n"]);
  });
});

describe("LineEndingRepair: a server that keeps endings", () => {
  it("leaves a stream alone", async () => {
    const events = await run(new LineEndingRepair(), [out("a\n"), out("b\n"), exit()]);
    expect(texts(events)).toEqual(["a\n", "b\n"]);
  });

  it("leaves a trailing fragment alone", async () => {
    const events = await run(new LineEndingRepair(), [out("one\n"), out("tail"), exit()]);
    expect(texts(events)).toEqual(["one\n", "tail"]);
  });

  it("leaves a line split across events alone: 'abc' then 'def\\n'", async () => {
    const events = await run(new LineEndingRepair(), [out("abc"), out("def\n"), exit()]);
    expect(texts(events)).toEqual(["abc", "def\n"]);
  });

  it("leaves a single ending-less event alone (printf abc)", async () => {
    const events = await run(new LineEndingRepair(), [out("abc"), exit()]);
    expect(texts(events)).toEqual(["abc"]);
  });

  it("counts a carriage return as an ending (progress output)", async () => {
    const events = await run(new LineEndingRepair(), [out("10%\r"), out("20%\r"), exit()]);
    expect(texts(events)).toEqual(["10%\r", "20%\r"]);
  });

  it("stops holding anything once a stream has shown it keeps endings", async () => {
    const repair = new LineEndingRepair();
    await run(repair, [out("a\n"), exit()]);

    // Two ending-less events now, on a server already known to keep them: untouched, and not held.
    const events = await run(repair, [out("x"), out("y"), exit()]);
    expect(texts(events)).toEqual(["x", "y"]);
  });
});

describe("LineEndingRepair: edges", () => {
  it("passes non-output events through, in order", async () => {
    const init: ExecEvent = { type: "init", text: "id", timestamp: 0 };
    const events = await run(new LineEndingRepair(), [init, out("a"), out("b"), done()]);
    expect(events.map((e) => e.type)).toEqual(["init", "stdout", "stdout", "execution_complete"]);
  });

  it("does not lose held output when the stream ends with no terminal event", async () => {
    const events = await run(new LineEndingRepair(), [out("a"), out("b")]);
    expect(texts(events)).toEqual(["a\n", "b\n"]);
  });
});

describe("withLineEndingRepair", () => {
  function innerWith(events: ExecEvent[]): ExecChannel {
    const stub = new Proxy({} as ExecChannel, {
      get: (_t, prop) => {
        if (prop === "executeCommand" || prop === "runInSession") return () => stream(events);
        if (prop === "withSignal") return () => stub;
        return () => Promise.resolve(prop);
      },
    });
    return stub;
  }

  it("repairs command output", async () => {
    const channel = withLineEndingRepair(innerWith([out("a"), out("b"), exit()]));
    const seen: string[] = [];
    for await (const ev of channel.executeCommand({ command: "x" })) {
      if (ev.type === "stdout") seen.push(ev.text ?? "");
    }
    expect(seen).toEqual(["a\n", "b\n"]);
  });

  it("repairs session output too", async () => {
    const channel = withLineEndingRepair(innerWith([out("a"), out("b"), exit()]));
    const seen: string[] = [];
    for await (const ev of channel.runInSession("s", { command: "x" })) {
      if (ev.type === "stdout") seen.push(ev.text ?? "");
    }
    expect(seen).toEqual(["a\n", "b\n"]);
  });

  it("keeps repairing through withSignal, and shares what it learned", async () => {
    const repair = new LineEndingRepair();
    const channel = withLineEndingRepair(innerWith([out("a"), out("b"), exit()]), repair);
    const aborted = channel.withSignal(new AbortController().signal);
    const seen: string[] = [];
    for await (const ev of aborted.executeCommand({ command: "x" })) {
      if (ev.type === "stdout") seen.push(ev.text ?? "");
    }
    expect(seen).toEqual(["a\n", "b\n"]);
  });

  it("delegates everything else untouched", async () => {
    const channel = withLineEndingRepair(innerWith([]));
    await expect(channel.getFileInfo("/x")).resolves.toBe("getFileInfo");
  });
});
