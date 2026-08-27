import { describe, expect, it, vi } from "vitest";
import { InteractiveExecHandle } from "../src/exec-handle.ts";
import type { ExecDriver, ExecResult, PtyControls } from "../src/exec-handle.ts";

function makePtyDriver(
  // eslint-disable-next-line typescript/require-await -- the default onDone must match ExecDriver's Promise-returning signature; nothing here needs to await
  onDone: (r: ExecResult) => Promise<void> = async () => {},
) {
  let push: (chunk: string) => void = () => {};
  let finish: (exitCode: number) => void = () => {};
  let fail: (err: unknown) => void = () => {};

  const driver: ExecDriver = {
    type: "pty",
    attach: (p, f, fl) => {
      push = p;
      finish = f;
      fail = fl;
    },
    onDone,
  };

  return {
    driver,
    emitOutput: (chunk: string) => {
      push(chunk);
    },
    emitExit: (exitCode: number) => {
      finish(exitCode);
    },
    emitFail: (err: unknown) => {
      fail(err);
    },
  };
}

describe("InteractiveExecHandle — pty driver", () => {
  it("resolves with the exit code from the exit frame", async () => {
    const { driver, emitOutput, emitExit } = makePtyDriver();
    const handle = new InteractiveExecHandle(driver);
    emitOutput("hello\n");
    emitExit(0);
    const result = await handle;
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("streams output via stdout() as chunks arrive", async () => {
    const { driver, emitOutput, emitExit } = makePtyDriver();
    const handle = new InteractiveExecHandle(driver);
    const chunks: string[] = [];
    const collect = (async () => {
      for await (const chunk of handle.stdout()) chunks.push(chunk);
    })();
    emitOutput("a");
    emitOutput("b");
    emitExit(0);
    await collect;
    expect(chunks).toEqual(["a", "b"]);
  });

  it("seeds recorded scrollback before live output", async () => {
    const driver: ExecDriver = {
      type: "pty",
      seedStdout: "recorded before resume\n",
      attach: (push, finish) => {
        push("live output\n");
        finish(0);
      },
      // eslint-disable-next-line typescript/require-await -- must match ExecDriver's Promise-returning onDone signature; nothing here needs to await
      onDone: async () => {},
    };
    const handle = new InteractiveExecHandle(driver);
    const result = await handle;
    expect(result.stdout).toBe("recorded before resume\nlive output\n");
  });

  it("write()/resize()/signal()/close() forward to controls", () => {
    const { driver } = makePtyDriver();
    const controls: PtyControls = {
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      close: vi.fn(),
    };
    const handle = new InteractiveExecHandle(driver, controls);

    handle.write("whoami\n");
    handle.resize(80, 24);
    handle.signal("SIGINT");
    void handle.close();

    expect(controls.write).toHaveBeenCalledWith("whoami\n");
    expect(controls.resize).toHaveBeenCalledWith(80, 24);
    expect(controls.signal).toHaveBeenCalledWith("SIGINT");
    expect(controls.close).toHaveBeenCalled();
  });

  it("write()/resize()/signal()/close() are no-ops without controls (finished/replayed session)", () => {
    const { driver } = makePtyDriver();
    const handle = new InteractiveExecHandle(driver);
    expect(() => {
      handle.write("x");
    }).not.toThrow();
    expect(() => {
      handle.resize(1, 1);
    }).not.toThrow();
    expect(() => {
      handle.signal("SIGTERM");
    }).not.toThrow();
    expect(() => {
      void handle.close();
    }).not.toThrow();
  });

  it("rejects if the driver reports a setup failure", async () => {
    const { driver, emitFail } = makePtyDriver();
    const handle = new InteractiveExecHandle(driver);
    emitFail(new Error("connection refused"));
    await expect(handle).rejects.toThrow("connection refused");
  });

  it("calls onDone with the completed result", async () => {
    let captured: unknown;
    const { driver, emitExit } = makePtyDriver(
      // eslint-disable-next-line typescript/require-await -- onDone must match ExecDriver's Promise-returning signature; nothing here needs to await
      async (r) => {
        captured = r;
      },
    );
    const handle = new InteractiveExecHandle(driver);
    emitExit(3);
    await handle;
    expect((captured as { exitCode: number }).exitCode).toBe(3);
  });
});

describe("InteractiveExecHandle — replay driver (already finished before checkpoint)", () => {
  it("resolves immediately with the cached result", async () => {
    const handle = new InteractiveExecHandle({
      type: "replay",
      result: { stdout: "cached\n", stderr: "", exitCode: 0 },
    });
    const result = await handle;
    expect(result.stdout).toBe("cached\n");
  });

  // eslint-disable-next-line typescript/require-await -- vitest `it` callbacks are conventionally async even when this one has nothing to await
  it("write() is a no-op — nothing left to attach to", async () => {
    const handle = new InteractiveExecHandle({
      type: "replay",
      result: { stdout: "", stderr: "", exitCode: 0 },
    });
    expect(() => {
      handle.write("too late");
    }).not.toThrow();
  });
});
