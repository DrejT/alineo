import { describe, expect, it, vi } from "vitest";
import { SandboxHandle } from "../src/sandbox/index.ts";
import { SSEEventType } from "@alineo-labs/opensandbox";
import type { SSEEvent } from "@alineo-labs/opensandbox";
import type { SandboxDeps } from "../src/sandbox/index.ts";
import type { IStorageAdapter, LedgerEntry } from "../src/ledger.ts";
import { LedgerEvent } from "../src/ledger.ts";
import type { ExecResult } from "../src/exec-handle.ts";

function makeAdapter(): IStorageAdapter {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    readAll: vi.fn().mockResolvedValue([]),
    lastCheckpoint: vi.fn().mockResolvedValue(null),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    listSandboxDetails: vi.fn().mockResolvedValue([]),
    listAllSandboxDetails: vi.fn().mockResolvedValue([]),
    getSandboxDetails: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn().mockResolvedValue(null),
    saveEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
  };
}

function makeExecClient(events: SSEEvent[] = []) {
  return {
    listContexts: vi.fn().mockResolvedValue([]),
    executeCommand: vi.fn().mockImplementation(() =>
      // eslint-disable-next-line typescript/require-await -- an async generator needs no top-level await; it yields synchronously-known events
      (async function* () {
        for (const ev of events) yield ev;
      })(),
    ),
  };
}

interface SandboxTestInternals {
  _execClient: unknown;
}

/** SandboxCore._execClient is private; this reaches it for tests that need to inject a fake. */
function setExecClient(sb: SandboxHandle, client: ReturnType<typeof makeExecClient>): void {
  (sb as unknown as SandboxTestInternals)._execClient = client;
}

function makeDeps(adapter: IStorageAdapter): SandboxDeps {
  return {
    control: {} as unknown as SandboxDeps["control"],
    adapter,
  };
}

function appendedEntries(adapter: IStorageAdapter): LedgerEntry[] {
  return (adapter.append as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as LedgerEntry);
}

describe("SandboxHandle replay mode", () => {
  it("returns cached result without calling execClient", async () => {
    const adapter = makeAdapter();
    const cached: ExecResult = { stdout: "cached output\n", stderr: "", exitCode: 0 };
    const replayCache = new Map([[1, cached]]);
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), replayCache);

    const execClient = makeExecClient();
    setExecClient(sb, execClient);

    const handle = sb.exec("npm ci");
    const result = await handle;

    expect(result.stdout).toBe("cached output\n");
    expect(result.exitCode).toBe(0);
    expect(execClient.executeCommand).not.toHaveBeenCalled();
  });

  it("plays back multiple cached execs in sequence", async () => {
    const adapter = makeAdapter();
    const replayCache = new Map<number, ExecResult>([
      [1, { stdout: "install done\n", stderr: "", exitCode: 0 }],
      [2, { stdout: "build done\n", stderr: "", exitCode: 0 }],
    ]);
    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), replayCache);
    setExecClient(sb, makeExecClient());

    const r1 = await sb.exec("npm ci");
    const r2 = await sb.exec("npm run build");

    expect(r1.stdout).toBe("install done\n");
    expect(r2.stdout).toBe("build done\n");
  });

  it("executes normally after the replay cache is exhausted", async () => {
    const adapter = makeAdapter();
    const replayCache = new Map<number, ExecResult>([
      [1, { stdout: "cached\n", stderr: "", exitCode: 0 }],
    ]);

    const liveEvents: SSEEvent[] = [
      { type: SSEEventType.Stdout, text: "live output\n", timestamp: 0 },
      { type: SSEEventType.Error, error: { message: "exit", evalue: "0" }, timestamp: 0 },
    ];
    const execClient = makeExecClient(liveEvents);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), replayCache);
    setExecClient(sb, execClient);

    const r1 = await sb.exec("npm ci"); // seq=1, cached
    const r2 = await sb.exec("npm test"); // seq=2, live

    expect(r1.stdout).toBe("cached\n");
    expect(r2.stdout).toBe("live output\n");
    expect(execClient.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("seq counter increments across cached and live execs", async () => {
    const adapter = makeAdapter();
    const replayCache = new Map<number, ExecResult>([
      [1, { stdout: "a\n", stderr: "", exitCode: 0 }],
      [2, { stdout: "b\n", stderr: "", exitCode: 0 }],
    ]);
    const execClient = makeExecClient([
      { type: SSEEventType.Stdout, text: "c\n", timestamp: 0 },
      { type: SSEEventType.Error, error: { message: "exit", evalue: "0" }, timestamp: 0 },
    ]);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter), replayCache);
    setExecClient(sb, execClient);

    const results = await Promise.all([
      sb.exec("cmd1"), // seq=1, cached
      sb.exec("cmd2"), // seq=2, cached
      sb.exec("cmd3"), // seq=3, live
    ]);

    expect(results[0].stdout).toBe("a\n");
    expect(results[1].stdout).toBe("b\n");
    expect(results[2].stdout).toBe("c\n");
  });
});

describe("SandboxHandle live mode", () => {
  it("logs exec_start and exec_complete to adapter", async () => {
    const adapter = makeAdapter();
    const liveEvents: SSEEvent[] = [
      { type: SSEEventType.Stdout, text: "hi\n", timestamp: 0 },
      { type: SSEEventType.Error, error: { message: "exit", evalue: "0" }, timestamp: 0 },
    ];
    const execClient = makeExecClient(liveEvents);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    setExecClient(sb, execClient);

    await sb.exec("echo hi");

    const events = appendedEntries(adapter).map((e) => e.event);
    expect(events).toContain(LedgerEvent.ExecStart);
    expect(events).toContain(LedgerEvent.ExecEvent);
    expect(events).toContain(LedgerEvent.ExecComplete);
  });

  it("ledger entries use sandboxId, not runId", async () => {
    const adapter = makeAdapter();
    const liveEvents: SSEEvent[] = [
      { type: SSEEventType.Error, error: { message: "exit", evalue: "0" }, timestamp: 0 },
    ];
    const execClient = makeExecClient(liveEvents);

    const sb = new SandboxHandle("session-abc", "test", makeDeps(adapter));
    setExecClient(sb, execClient);

    await sb.exec("true");

    for (const entry of appendedEntries(adapter)) {
      expect(entry.sandboxId).toBe("session-abc");
      expect((entry as unknown as { runId?: unknown }).runId).toBeUndefined();
    }
  });

  it("calls CommandError on non-zero exit with strict:true (default)", async () => {
    const adapter = makeAdapter();
    const liveEvents: SSEEvent[] = [
      { type: SSEEventType.Error, error: { message: "exit", evalue: "1" }, timestamp: 0 },
    ];
    const execClient = makeExecClient(liveEvents);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    setExecClient(sb, execClient);

    await expect(sb.exec("exit 1")).rejects.toThrow("Command exited with code 1");
  });

  it("does not throw on non-zero exit with strict:false", async () => {
    const adapter = makeAdapter();
    const liveEvents: SSEEvent[] = [
      { type: SSEEventType.Error, error: { message: "exit", evalue: "1" }, timestamp: 0 },
    ];
    const execClient = makeExecClient(liveEvents);

    const sb = new SandboxHandle("sb-1", "test", makeDeps(adapter));
    setExecClient(sb, execClient);

    const result = await sb.exec("exit 1", { strict: false });
    expect(result.exitCode).toBe(1);
  });
});
