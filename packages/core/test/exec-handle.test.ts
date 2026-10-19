import { describe, expect, it } from "vitest";
import { ExecHandle } from "../src/exec-handle.ts";
import type { ExecEvent } from "@alineo-labs/provider";

function makeStream(events: ExecEvent[]): AsyncGenerator<ExecEvent> {
  // eslint-disable-next-line typescript/require-await -- must be an async generator to match the return type; nothing here needs to await
  return (async function* () {
    for (const ev of events) yield ev;
  })();
}

function stdout(text: string): ExecEvent {
  return { type: "stdout", text, timestamp: 0 };
}

function stderr(text: string): ExecEvent {
  return { type: "stderr", text, timestamp: 0 };
}

function error(exitCode: number): ExecEvent {
  return {
    type: "error",
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

function killedBy(signal: string): ExecEvent {
  return {
    type: "error",
    error: {
      message: "",
      ename: "CommandExecError",
      evalue: "-1",
      traceback: [`signal: ${signal}`],
    },
    timestamp: 0,
  };
}

describe("how a command ended", () => {
  it("reports a duration for every command", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([stdout("ok\n"), error(0)]),
      onDone: async () => {},
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result).not.toHaveProperty("killed");
    expect(result).not.toHaveProperty("timedOut");
  });

  it("does not call a plain non-zero exit a kill", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([
        {
          type: "error",
          error: {
            message: "",
            ename: "CommandExecError",
            evalue: "3",
            traceback: ["exit status 3"],
          },
          timestamp: 0,
        },
      ]),
      onDone: async () => {},
    });
    expect(result.exitCode).toBe(3);
    expect(result).not.toHaveProperty("killed");
  });

  it("reports a signal kill, and not a timeout when it came long before the limit", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([killedBy("killed")]),
      timeoutMs: 60_000,
      onDone: async () => {},
    });
    expect(result).toMatchObject({ killed: true, signal: "killed", timedOut: false, exitCode: -1 });
  });

  it("calls a kill after the limit a timeout", async () => {
    // eslint-disable-next-line typescript/require-await -- an async generator by signature
    async function* slowThenKilled(): AsyncGenerator<ExecEvent> {
      await new Promise((r) => setTimeout(r, 60));
      yield killedBy("killed");
    }
    const result = await new ExecHandle({
      type: "stream",
      gen: slowThenKilled(),
      timeoutMs: 50,
      onDone: async () => {},
    });
    expect(result).toMatchObject({ killed: true, signal: "killed", timedOut: true });
  });

  it("never reports a timeout for a command with no limit", async () => {
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([killedBy("killed")]),
      onDone: async () => {},
    });
    expect(result.timedOut).toBe(false);
  });

  it("reports a command execd could not start as a failure, not as exit 0", async () => {
    const startFailure: ExecEvent = {
      type: "error",
      error: {
        ename: "CommandExecError",
        evalue: "fork/exec /usr/bin/bash: argument list too long",
        traceback: [],
      },
      timestamp: 0,
    } as ExecEvent;
    const result = await new ExecHandle({
      type: "stream",
      gen: makeStream([startFailure]),
      onDone: async () => {},
    }).result();
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("argument list too long");
  });
});
