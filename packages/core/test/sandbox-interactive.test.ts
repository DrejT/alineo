import { describe, expect, it, vi } from "vitest";
import { SandboxHandle } from "../src/sandbox/index.ts";
import type { SandboxDeps, PendingInteractiveExec } from "../src/sandbox/index.ts";
import type { IStorageAdapter } from "../src/ledger.ts";
import type { ExecResult } from "../src/exec-handle.ts";

function makeAdapter(): IStorageAdapter {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue([]),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(adapter: IStorageAdapter): SandboxDeps {
  return {
    control: { deleteSandbox: vi.fn().mockResolvedValue(undefined) } as any,
    adapter,
  };
}

/** A controllable fake PtyClient — connect() resolves without ending the session until emitExit() is called. */
function makeFakePty() {
  let onOutputCb: (chunk: string) => void = () => {};
  let onExitCb: (exitCode: number) => void = () => {};
  const pty = {
    create: vi.fn().mockResolvedValue("session-1"),
    connect: vi.fn().mockImplementation(async (_sessionId: string, onOutput: any, onExit: any) => {
      onOutputCb = onOutput;
      onExitCb = onExit;
      onOutput("$ "); // simulate the shell's initial prompt — the readiness signal exec() waits for
    }),
    write: vi.fn(),
    resize: vi.fn(),
    signal: vi.fn(),
    close: vi.fn(),
  };
  return {
    pty,
    emitOutput: (chunk: string) => onOutputCb(chunk),
    emitExit: (exitCode: number) => onExitCb(exitCode),
  };
}

function appendedEvents(adapter: IStorageAdapter) {
  return (adapter.append as ReturnType<typeof vi.fn>).mock.calls.map((c: [any]) => c[0]);
}

describe("SandboxHandle interactive exec", () => {
  it("logs exec_start with interactive:true and the launch command", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    sb.exec("bash", { interactive: true });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    const start = appendedEvents(adapter).find((e) => e.event === "exec_start");
    expect(start?.payload).toMatchObject({ cmd: "bash", interactive: true, seq: 1 });
  });

  it("logs each write() as an exec_event with type stdin", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    const handle = sb.exec("bash", { interactive: true });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    handle.write("whoami\n");
    await vi.waitFor(() => expect(pty.write).toHaveBeenCalledWith("whoami\n"));

    const stdinEvents = appendedEvents(adapter).filter(
      (e) => e.event === "exec_event" && e.payload?.type === "stdin",
    );
    expect(stdinEvents.map((e) => e.payload.text)).toEqual(["whoami\n"]);
  });

  it("logs output chunks as exec_event with type stdout", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty, emitOutput } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    sb.exec("bash", { interactive: true });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    emitOutput("hello\n");
    await vi.waitFor(() => {
      const stdoutEvents = appendedEvents(adapter).filter(
        (e) => e.event === "exec_event" && e.payload?.type === "stdout",
      );
      // "$ " is the fake's simulated initial prompt (the readiness signal exec() waits for)
      expect(stdoutEvents.map((e) => e.payload.text)).toEqual(["$ ", "hello\n"]);
    });
  });

  it("resolves with the exit code and logs exec_complete", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty, emitExit } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    const handle = sb.exec("bash", { interactive: true, strict: false });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    emitExit(0);
    const result = await handle;
    expect(result.exitCode).toBe(0);
    const complete = appendedEvents(adapter).find((e) => e.event === "exec_complete");
    expect(complete?.payload).toMatchObject({ exitCode: 0, seq: 1 });
  });

  it("throws CommandError on non-zero exit with strict:true (default)", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty, emitExit } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    const handle = sb.exec("bash", { interactive: true });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    emitExit(1);
    await expect(handle).rejects.toThrow("Command exited with code 1");
  });

  it("does not throw on non-zero exit with strict:false", async () => {
    const adapter = makeAdapter();
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    const { pty, emitExit } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    const handle = sb.exec("bash", { interactive: true, strict: false });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    emitExit(1);
    const result = await handle;
    expect(result.exitCode).toBe(1);
  });

  it("sb.close() closes any still-open interactive session", async () => {
    const adapter = makeAdapter();
    const deps = makeDeps(adapter);
    const sb = new SandboxHandle("sb-1", "test", deps);
    const { pty } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    sb.exec("bash", { interactive: true });
    await vi.waitFor(() => expect((sb as any).openSessionClosers.size).toBe(1));

    await sb.close();
    expect(pty.close).toHaveBeenCalled();
    expect((sb as any).openSessionClosers.size).toBe(0);
  });

  it("replayed (already-finished) interactive exec resolves instantly without opening a pty", async () => {
    const adapter = makeAdapter();
    const cached: ExecResult = { stdout: "done before checkpoint\n", stderr: "", exitCode: 0 };
    const replayCache = new Map([[1, cached]]);
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), replayCache);
    const resolvePty = vi.fn();
    (sb as any).resolvePtyClient = resolvePty;

    const handle = sb.exec("bash", { interactive: true });
    const result = await handle;

    expect(result).toEqual(cached);
    expect(resolvePty).not.toHaveBeenCalled();
  });

  it("resume: replays recorded stdin in order before any new write reaches the pty", async () => {
    const adapter = makeAdapter();
    const pendingInteractive = new Map<number, PendingInteractiveExec>([
      [
        1,
        {
          cmd: "bash",
          stdin: ["export FOO=bar\n", "echo $FOO\n"],
          stdout: "recorded before checkpoint\n",
        },
      ],
    ]);
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), new Map(), pendingInteractive);
    const { pty } = makeFakePty();
    (sb as any).resolvePtyClient = vi.fn().mockResolvedValue(pty);

    const handle = sb.exec("bash", { interactive: true });
    // Resuming pays a fixed settle delay (see sandbox.ts) before replaying stdin.
    await vi.waitFor(() => expect(pty.write).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(pty.write.mock.calls.map((c: [string]) => c[0])).toEqual([
      "export FOO=bar\n",
      "echo $FOO\n",
    ]);

    handle.write("echo new\n");
    await vi.waitFor(() => expect(pty.write).toHaveBeenCalledTimes(3));
    expect(pty.write.mock.calls[2][0]).toBe("echo new\n");
  }, 10_000);
});
