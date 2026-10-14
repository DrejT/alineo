import { describe, expect, it } from "vitest";
import { ExecHandle, joinOutputEvents, lineEndingsStripped } from "../src/exec-handle.ts";
import { SSEEventType } from "@alineo-labs/opensandbox";
import type { SSEEvent } from "@alineo-labs/opensandbox";

function makeStream(events: SSEEvent[]): AsyncGenerator<SSEEvent> {
  // eslint-disable-next-line typescript/require-await -- must be an async generator to match the return type; nothing here needs to await
  return (async function* () {
    for (const ev of events) yield ev;
  })();
}

function stdout(text: string): SSEEvent {
  return { type: SSEEventType.Stdout, text, timestamp: 0 };
}

function stderr(text: string): SSEEvent {
  return { type: SSEEventType.Stderr, text, timestamp: 0 };
}

function error(exitCode: number): SSEEvent {
  return {
    type: SSEEventType.Error,
    error: { message: "exit", evalue: String(exitCode) },
    timestamp: 0,
  };
}

describe("ExecHandle — streaming mode", () => {
  it("resolves via then() with stdout and exitCode", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("hello\n"), error(0)]),
      onDone: async () => {},
    });
    const result = await handle;
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("resolves via result()", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("hi"), error(0)]),
      onDone: async () => {},
    });
    const result = await handle.result();
    expect(result.stdout).toBe("hi");
  });

  it("collects stderr separately", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stderr("err\n"), error(1)]),
      onDone: async () => {},
    });
    const result = await handle;
    expect(result.stderr).toBe("err\n");
    expect(result.exitCode).toBe(1);
  });

  it("streams stdout chunks via stdout() generator", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("a\n"), stdout("b\n"), stdout("c\n"), error(0)]),
      onDone: async () => {},
    });
    const chunks: string[] = [];
    for await (const chunk of handle.stdout()) chunks.push(chunk);
    expect(chunks).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("pipe() writes chunks to writable", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("x\n"), stdout("y\n"), error(0)]),
      onDone: async () => {},
    });
    const written: string[] = [];
    await handle.pipe({ write: (c) => written.push(c) });
    expect(written).toEqual(["x\n", "y\n"]);
  });

  it("calls onDone with the completed result", async () => {
    let capturedResult: unknown;
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("out"), error(42)]),
      // eslint-disable-next-line typescript/require-await -- onDone must match ExecDriver's Promise-returning signature; nothing here needs to await
      onDone: async (r) => {
        capturedResult = r;
      },
    });
    await handle;
    expect((capturedResult as { exitCode: number }).exitCode).toBe(42);
    expect((capturedResult as { stdout: string }).stdout).toBe("out");
  });
});

describe("ExecHandle — replay mode", () => {
  it("resolves immediately with cached result", async () => {
    const cached = { stdout: "cached output\n", stderr: "", exitCode: 0 };
    const handle = new ExecHandle({ type: "replay", result: cached });
    const result = await handle;
    expect(result).toEqual(cached);
  });

  it("yields stdout via stdout() generator", async () => {
    const handle = new ExecHandle({
      type: "replay",
      result: { stdout: "hello", stderr: "", exitCode: 0 },
    });
    const chunks: string[] = [];
    for await (const chunk of handle.stdout()) chunks.push(chunk);
    expect(chunks.join("")).toBe("hello");
  });

  it("pipe() works in replay mode", async () => {
    const handle = new ExecHandle({
      type: "replay",
      result: { stdout: "piped", stderr: "", exitCode: 0 },
    });
    const written: string[] = [];
    await handle.pipe({ write: (c) => written.push(c) });
    expect(written.join("")).toBe("piped");
  });

  it("result() works in replay mode", async () => {
    const handle = new ExecHandle({
      type: "replay",
      result: { stdout: "x", stderr: "", exitCode: 5 },
    });
    const result = await handle.result();
    expect(result.exitCode).toBe(5);
  });
});

describe("line endings dropped by execd before 1.1.1", () => {
  it("restores them in the result when every event is a bare line", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("one"), stdout("two"), stdout("three"), error(0)]),
      onDone: async () => {},
    });
    expect(result.stdout).toBe("one\ntwo\nthree\n");
  });

  it("does the same for stderr", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stderr("e1"), stderr("e2"), error(1)]),
      onDone: async () => {},
    });
    expect(result.stderr).toBe("e1\ne2\n");
  });

  it("leaves a stream alone when the events carry their own endings", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("one\n"), stdout("two\n"), error(0)]),
      onDone: async () => {},
    });
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("leaves a trailing fragment alone when earlier events had endings", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("one\n"), stdout("tail"), error(0)]),
      onDone: async () => {},
    });
    expect(result.stdout).toBe("one\ntail");
  });

  it("leaves a single ending-less event alone (printf abc)", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("abc"), error(0)]),
      onDone: async () => {},
    });
    expect(result.stdout).toBe("abc");
  });

  it("restores the endings in the streamed chunks too", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("one"), stdout("two"), stdout("three"), error(0)]),
      onDone: async () => {},
    });
    const chunks: string[] = [];
    for await (const chunk of handle.stdout()) chunks.push(chunk);
    expect(chunks.join("")).toBe("one\ntwo\nthree\n");
    expect(chunks).toEqual(["one\n", "two\n", "three\n"]);
  });

  it("does not hold back chunks from a server that keeps endings", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("a\n"), stdout("b\n"), error(0)]),
      onDone: async () => {},
    });
    const chunks: string[] = [];
    for await (const chunk of handle.stdout()) chunks.push(chunk);
    expect(chunks).toEqual(["a\n", "b\n"]);
  });

  it("a carriage return counts as an ending (progress output)", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("10%\r"), stdout("20%\r"), error(0)]),
      onDone: async () => {},
    });
    expect(result.stdout).toBe("10%\r20%\r");
  });

  it("lineEndingsStripped needs at least two events", () => {
    expect(lineEndingsStripped([])).toBe(false);
    expect(lineEndingsStripped(["a"])).toBe(false);
    expect(lineEndingsStripped(["a", "b"])).toBe(true);
    expect(lineEndingsStripped(["a", "b\n"])).toBe(false);
  });

  it("joinOutputEvents joins plainly when endings are present", () => {
    expect(joinOutputEvents(["a\n", "b\n"])).toBe("a\nb\n");
    expect(joinOutputEvents([])).toBe("");
  });
});
