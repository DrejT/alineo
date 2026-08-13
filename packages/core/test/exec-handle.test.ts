import { describe, expect, it } from "vitest";
import { ExecHandle } from "../src/exec-handle.ts";
import { SSEEventType } from "@alineo-labs/opensandbox";
import type { SSEEvent } from "@alineo-labs/opensandbox";

function makeStream(events: SSEEvent[]): AsyncGenerator<SSEEvent> {
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
      gen: makeStream([stdout("a"), stdout("b"), stdout("c"), error(0)]),
      onDone: async () => {},
    });
    const chunks: string[] = [];
    for await (const chunk of handle.stdout()) chunks.push(chunk);
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("pipe() writes chunks to writable", async () => {
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("x"), stdout("y"), error(0)]),
      onDone: async () => {},
    });
    const written: string[] = [];
    await handle.pipe({ write: (c) => written.push(c) });
    expect(written).toEqual(["x", "y"]);
  });

  it("calls onDone with the completed result", async () => {
    let capturedResult: unknown;
    const handle = new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("out"), error(42)]),
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
