import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "@alineo-labs/sandbox";
import { SandboxBuilder, flushOps, type FlushContext } from "../src/sandbox-builder.ts";

function makeCtx(overrides: Partial<FlushContext> = {}): FlushContext {
  return { stdout: "", exitCode: 0, vars: {}, ...overrides };
}

function makeSandbox(execResults: Record<string, string> = {}) {
  return {
    exec: vi.fn().mockImplementation((cmd: string) => {
      const stdout = execResults[cmd] ?? `output of: ${cmd}`;
      return {
        [Symbol.asyncIterator]: async function* () {
          yield stdout;
        },
        stdout: async function* () {
          yield stdout;
        },
        result: async () => ({ stdout, stderr: "", exitCode: 0 }),
        then: (ok: (r: unknown) => unknown) =>
          Promise.resolve(ok({ stdout, stderr: "", exitCode: 0 })),
        pipe: async (w: { write(s: string): unknown }) => {
          w.write(stdout);
        },
      };
    }),
    execCode: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("file content"),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SandboxBuilder — queue construction", () => {
  it("queues exec ops in order", () => {
    const sb = new SandboxBuilder();
    sb.exec("npm ci").exec("npm test");
    expect(sb._ops).toHaveLength(2);
    expect(sb._ops[0]).toMatchObject({ kind: "exec", cmd: "npm ci" });
    expect(sb._ops[1]).toMatchObject({ kind: "exec", cmd: "npm test" });
  });

  it("queues mixed op types", () => {
    const sb = new SandboxBuilder();
    sb.exec("ls").writeFile("/tmp/f", "hello").checkpoint().readFile("/tmp/f", "content");
    const kinds = sb._ops.map((o) => o.kind);
    expect(kinds).toEqual(["exec", "writeFile", "checkpoint", "readFile"]);
  });

  it("queues retry op", () => {
    const sb = new SandboxBuilder();
    sb.retry(3, (sb) => sb.exec("npm test"), { backoff: "exponential", delayMs: 100 });
    expect(sb._ops[0]).toMatchObject({ kind: "retry", maxAttempts: 3 });
  });

  it("queues when op", () => {
    const sb = new SandboxBuilder();
    sb.when(
      (ctx) => ctx.exitCode === 0,
      (sb) => sb.exec("echo pass"),
    );
    expect(sb._ops[0]).toMatchObject({ kind: "when" });
  });

  it("queues forEach op", () => {
    const sb = new SandboxBuilder();
    sb.forEach(["a", "b"], (sb, item) => sb.exec(`echo ${String(item)}`));
    expect(sb._ops[0]).toMatchObject({ kind: "forEach", items: ["a", "b"] });
  });
});

describe("flushOps — execution", () => {
  it("calls sandbox.exec for each exec op", async () => {
    const sb = new SandboxBuilder();
    sb.exec("cmd1").exec("cmd2");

    const sandbox = makeSandbox();
    const ctx = makeCtx();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, ctx);

    expect(sandbox.exec).toHaveBeenCalledWith("cmd1", {});
    expect(sandbox.exec).toHaveBeenCalledWith("cmd2", {});
  });

  it("calls sandbox.writeFile", async () => {
    const sb = new SandboxBuilder();
    sb.writeFile("/tmp/f", "hello");

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx());

    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/f", "hello");
  });

  it("calls sandbox.readFile and stores result in vars", async () => {
    const sb = new SandboxBuilder();
    sb.readFile("/tmp/f", "content");

    const sandbox = makeSandbox();
    const ctx = makeCtx();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, ctx);

    expect(sandbox.readFile).toHaveBeenCalledWith("/tmp/f");
    expect(ctx.vars["content"]).toBe("file content");
  });

  it("calls sandbox.checkpoint", async () => {
    const sb = new SandboxBuilder();
    sb.checkpoint("after-install");

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx());

    expect(sandbox.checkpoint).toHaveBeenCalledWith("after-install");
  });
});

describe("flushOps — when primitive", () => {
  it("executes then branch when predicate is true", async () => {
    const sb = new SandboxBuilder();
    sb.when(
      (ctx) => ctx.exitCode === 0,
      (sb) => {
        sb.exec("echo pass");
      },
      (sb) => {
        sb.exec("echo fail");
      },
    );

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx({ exitCode: 0 }));

    const calls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]);
    expect(calls).toContain("echo pass");
    expect(calls).not.toContain("echo fail");
  });

  it("executes else branch when predicate is false", async () => {
    const sb = new SandboxBuilder();
    sb.when(
      (ctx) => ctx.exitCode === 0,
      (sb) => {
        sb.exec("echo pass");
      },
      (sb) => {
        sb.exec("echo fail");
      },
    );

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx({ exitCode: 1 }));

    const calls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]);
    expect(calls).toContain("echo fail");
    expect(calls).not.toContain("echo pass");
  });
});

describe("flushOps — forEach primitive", () => {
  it("runs fn for each item sequentially", async () => {
    const sb = new SandboxBuilder();
    sb.forEach(["a", "b", "c"], (sb, item) => {
      sb.exec(`echo ${String(item)}`);
    });

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx());

    const calls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]);
    expect(calls).toEqual(["echo a", "echo b", "echo c"]);
  });
});

describe("flushOps — retry primitive", () => {
  it("succeeds on first attempt without retrying", async () => {
    const sb = new SandboxBuilder();
    sb.retry(3, (sb) => {
      sb.exec("cmd");
    });

    const sandbox = makeSandbox();
    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx());

    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    let attempts = 0;
    const sandbox = {
      exec: vi.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          return {
            stdout: async function* () {},
            result: async () => {
              throw new Error("failed");
            },
            then: (_ok: unknown, reject: (e: Error) => unknown) =>
              Promise.resolve(reject(new Error("failed"))),
            pipe: async () => {
              throw new Error("failed");
            },
          };
        }
        return {
          stdout: async function* () {
            yield "success";
          },
          result: async () => ({ stdout: "success", stderr: "", exitCode: 0 }),
          then: (ok: (r: unknown) => unknown) =>
            Promise.resolve(ok({ stdout: "success", stderr: "", exitCode: 0 })),
          pipe: async () => {},
        };
      }),
    };

    const sb = new SandboxBuilder();
    sb.retry(
      5,
      (sb) => {
        sb.exec("flaky-cmd");
      },
      { delayMs: 0 },
    );

    await flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx());
    expect(attempts).toBe(3);
  });

  it("throws after exhausting all attempts", async () => {
    const sandbox = {
      exec: vi.fn().mockImplementation(() => ({
        stdout: async function* () {},
        result: async () => {
          throw new Error("always fails");
        },
        then: (_ok: unknown, reject: (e: Error) => unknown) =>
          Promise.resolve(reject(new Error("always fails"))),
        pipe: async () => {
          throw new Error("always fails");
        },
      })),
    };

    const sb = new SandboxBuilder();
    sb.retry(
      3,
      (sb) => {
        sb.exec("broken");
      },
      { delayMs: 0 },
    );

    await expect(flushOps(sandbox as unknown as SandboxHandle, sb._ops, makeCtx())).rejects.toThrow(
      "always fails",
    );
    expect(sandbox.exec).toHaveBeenCalledTimes(3);
  });
});
