import { describe, expect, it, vi } from "vitest";
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
    writeFileBytes: vi.fn().mockResolvedValue(undefined),
    readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([0x50, 0x4b, 0xff, 0x00])),
    credentials: {
      set: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      listBindings: vi.fn().mockResolvedValue([]),
    },
    egress: {
      patch: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({}),
    },
    proxy: vi.fn().mockResolvedValue({ url: "http://proxy/1", headers: {} }),
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
    await flushOps(sandbox, sb._ops, ctx);

    expect(sandbox.exec).toHaveBeenCalledWith("cmd1", {});
    expect(sandbox.exec).toHaveBeenCalledWith("cmd2", {});
  });

  it("calls sandbox.writeFile", async () => {
    const sb = new SandboxBuilder();
    sb.writeFile("/tmp/f", "hello");

    const sandbox = makeSandbox();
    await flushOps(sandbox, sb._ops, makeCtx());

    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/f", "hello");
  });

  it("calls sandbox.readFile and stores result in vars", async () => {
    const sb = new SandboxBuilder();
    sb.readFile("/tmp/f", "content");

    const sandbox = makeSandbox();
    const ctx = makeCtx();
    await flushOps(sandbox, sb._ops, ctx);

    expect(sandbox.readFile).toHaveBeenCalledWith("/tmp/f");
    expect(ctx.vars["content"]).toBe("file content");
  });

  it("calls sandbox.checkpoint", async () => {
    const sb = new SandboxBuilder();
    sb.checkpoint("after-install");

    const sandbox = makeSandbox();
    await flushOps(sandbox, sb._ops, makeCtx());

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
    await flushOps(sandbox, sb._ops, makeCtx({ exitCode: 0 }));

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
    await flushOps(sandbox, sb._ops, makeCtx({ exitCode: 1 }));

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
    await flushOps(sandbox, sb._ops, makeCtx());

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
    await flushOps(sandbox, sb._ops, makeCtx());

    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    let attempts = 0;
    const sandbox = {
      ...makeSandbox(),
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

    await flushOps(sandbox, sb._ops, makeCtx());
    expect(attempts).toBe(3);
  });

  it("throws after exhausting all attempts", async () => {
    const sandbox = {
      ...makeSandbox(),
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

    await expect(flushOps(sandbox, sb._ops, makeCtx())).rejects.toThrow("always fails");
    expect(sandbox.exec).toHaveBeenCalledTimes(3);
  });
});

describe("SandboxBuilder — captured exec output", () => {
  it("stores one command's own stdout, trimmed, under `as`", async () => {
    const sandbox = makeSandbox({ "echo a": "first\n", "echo b": "second\n" });
    const sb = new SandboxBuilder();
    sb.exec("echo a").exec("echo b", { as: "b" });
    const ctx = makeCtx();
    await flushOps(sandbox, sb._ops, ctx);
    expect(ctx.vars.b).toBe("second");
    expect(ctx.stdout).toBe("first\nsecond\n");
  });

  it("parses JSON stdout when parse is json", async () => {
    const sandbox = makeSandbox({ probe: '{"success":true,"data":{"url":"https://x/dash"}}' });
    const sb = new SandboxBuilder();
    sb.exec("probe", { as: "probe", parse: "json" });
    const ctx = makeCtx();
    await flushOps(sandbox, sb._ops, ctx);
    expect(ctx.vars.probe).toEqual({ success: true, data: { url: "https://x/dash" } });
  });

  it("fails the step when JSON stdout does not parse", async () => {
    const sandbox = makeSandbox({ probe: "not json" });
    const sb = new SandboxBuilder();
    sb.exec("probe", { as: "probe", parse: "json" });
    await expect(flushOps(sandbox, sb._ops, makeCtx())).rejects.toThrow(/not valid JSON/);
  });

  it("does not pass workflow-only options to the sandbox", async () => {
    const sandbox = makeSandbox();
    const sb = new SandboxBuilder();
    sb.exec("ls", { as: "x", parse: "text", name: "list", strict: false, cwd: "/tmp" });
    await flushOps(sandbox, sb._ops, makeCtx());
    expect(sandbox.exec).toHaveBeenCalledWith("ls", { strict: false, cwd: "/tmp" });
  });

  it("captures under `as` in pipe mode too", async () => {
    const sandbox = makeSandbox({ "echo a": "piped\n" });
    const sb = new SandboxBuilder();
    sb.exec("echo a", { as: "a" });
    const chunks: string[] = [];
    const ctx = makeCtx({ sink: { write: (c: string) => chunks.push(c) } });
    await flushOps(sandbox, sb._ops, ctx);
    expect(ctx.vars.a).toBe("piped");
    expect(chunks).toEqual(["piped\n"]);
  });
});

describe("SandboxBuilder — bytes, credentials, egress", () => {
  it("reads bytes into vars without decoding them", async () => {
    const sandbox = makeSandbox();
    const sb = new SandboxBuilder();
    sb.readFileBytes("/tmp/report.xlsx", "report");
    const ctx = makeCtx();
    await flushOps(sandbox, sb._ops, ctx);
    expect(ctx.vars.report).toEqual(new Uint8Array([0x50, 0x4b, 0xff, 0x00]));
  });

  it("writes bytes", async () => {
    const sandbox = makeSandbox();
    const bytes = new Uint8Array([1, 2, 3]);
    const sb = new SandboxBuilder();
    sb.writeFileBytes("/tmp/state.json", bytes);
    await flushOps(sandbox, sb._ops, makeCtx());
    expect(sandbox.writeFileBytes).toHaveBeenCalledWith("/tmp/state.json", bytes);
  });

  it("registers a credential and changes egress rules", async () => {
    const sandbox = makeSandbox();
    const binding = {
      host: "seller.example.com",
      injection: { type: "substitution" as const, placeholder: "PW", in: ["body" as const] },
    };
    const sb = new SandboxBuilder();
    sb.setCredential("pw", "s3cret", binding)
      .patchEgress([{ action: "allow", target: "cdn.example.com" }])
      .deleteEgress(["cdn.example.com"]);
    await flushOps(sandbox, sb._ops, makeCtx());
    expect(sandbox.credentials.set).toHaveBeenCalledWith("pw", "s3cret", binding, undefined);
    expect(sandbox.egress.patch).toHaveBeenCalledWith([
      { action: "allow", target: "cdn.example.com" },
    ]);
    expect(sandbox.egress.delete).toHaveBeenCalledWith(["cdn.example.com"]);
  });
});

describe("SandboxBuilder — step events", () => {
  it("reports each leaf op, never the command text or values", async () => {
    const sandbox = makeSandbox();
    const events: unknown[] = [];
    const sb = new SandboxBuilder();
    sb.exec("fill #pw s3cret", { name: "login" })
      .when(
        () => true,
        (s) => s.readFileBytes("/tmp/r", "r"),
      )
      .setCredential("pw", "s3cret", {
        host: "x.example.com",
        injection: { type: "header", name: "Authorization" },
      });
    await flushOps(sandbox, sb._ops, makeCtx({ onEvent: (e) => events.push(e) }));

    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
    ]);
    expect(events[0]).toEqual({ type: "step.started", index: 0, name: "login", kind: "exec" });
    expect(events[1]).toMatchObject({ index: 0, name: "login", exitCode: 0 });
    expect(events[2]).toMatchObject({ index: 1, name: "readFileBytes" });
    expect(events[4]).toMatchObject({ index: 2, name: "setCredential" });
    expect(JSON.stringify(events)).not.toContain("s3cret");
  });

  it("reports a failed step with its error and rethrows", async () => {
    const sandbox = makeSandbox();
    sandbox.readFileBytes.mockRejectedValueOnce(new Error("no such file"));
    const events: Array<{ type: string; error?: string }> = [];
    const sb = new SandboxBuilder();
    sb.readFileBytes("/missing", "x");
    await expect(
      flushOps(sandbox, sb._ops, makeCtx({ onEvent: (e) => events.push(e) })),
    ).rejects.toThrow("no such file");
    expect(events[1]).toMatchObject({ type: "step.failed", error: "no such file" });
  });

  it("does not fail a step when the listener throws", async () => {
    const sandbox = makeSandbox();
    const sb = new SandboxBuilder();
    sb.exec("ls");
    await flushOps(
      sandbox,
      sb._ops,
      makeCtx({
        onEvent: () => {
          throw new Error("listener broke");
        },
      }),
    );
    expect(sandbox.exec).toHaveBeenCalledOnce();
  });

  it("keeps step indexes unique across parallel forEach workers", async () => {
    const sandbox = makeSandbox();
    const indexes: number[] = [];
    const sb = new SandboxBuilder();
    sb.forEach([1, 2, 3, 4], (s, i) => s.exec(`echo ${String(i)}`), { concurrency: 2 });
    await flushOps(
      sandbox,
      sb._ops,
      makeCtx({
        onEvent: (e) => {
          if (e.type === "step.started") indexes.push(e.index);
        },
      }),
    );
    expect([...indexes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe("host steps", () => {
  it("runs between the ops around it, with the sandbox and the vars so far", async () => {
    const sandbox = makeSandbox({ "echo a": "a" });
    const order: string[] = [];
    sandbox.exec.mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve({ stdout: cmd === "echo a" ? "a" : "", stderr: "", exitCode: 0 });
    });
    const sb = new SandboxBuilder();
    sb.exec("echo a", { as: "first" });
    sb.host("look", async (s, vars) => {
      order.push(`host:${String(vars.first)}`);
      await s.proxy(80);
    });
    sb.exec("echo b");
    await flushOps(sandbox, sb._ops, makeCtx());
    expect(order).toEqual(["echo a", "host:a", "echo b"]);
    expect(sandbox.proxy).toHaveBeenCalledWith(80);
  });

  it("reports its own name and kind, and fails the step when it throws", async () => {
    const sandbox = makeSandbox();
    const events: Array<{ type: string; name?: string; kind?: string; error?: string }> = [];
    const sb = new SandboxBuilder();
    sb.host("live view", () => undefined);
    sb.host("broken", () => {
      throw new Error("no port");
    });
    await expect(
      flushOps(sandbox, sb._ops, makeCtx({ onEvent: (e) => events.push(e) })),
    ).rejects.toThrow("no port");
    expect(events.map((e) => [e.type, e.name, e.kind])).toEqual([
      ["step.started", "live view", "host"],
      ["step.completed", "live view", "host"],
      ["step.started", "broken", "host"],
      ["step.failed", "broken", "host"],
    ]);
  });
});
