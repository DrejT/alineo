import { describe, expect, it, vi } from "vitest";
import type { ExecChannel, ExecEvent } from "@alineo-labs/provider";
import { SandboxHandle } from "../src/sandbox/index.ts";
import type { IStorageAdapter } from "../src/ledger.ts";
import { stubProvider } from "./provider-stub.ts";

function adapter(): IStorageAdapter {
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

const out = (text: string): ExecEvent => ({ type: "stdout", text, timestamp: 0 });
const exit0: ExecEvent = { type: "error", error: { evalue: "0" }, timestamp: 0 };

/** A channel whose command streams `events`, optionally throwing partway, and records interrupts. */
function channelWith(events: ExecEvent[], failAfter?: number) {
  const interruptCommand = vi.fn().mockResolvedValue(undefined);
  const channel: ExecChannel = {
    withSignal: () => channel,
    // eslint-disable-next-line typescript/require-await -- an async generator by signature
    executeCommand: async function* () {
      let n = 0;
      for (const ev of events) {
        if (failAfter !== undefined && n++ >= failAfter) throw new Error("stream broke");
        yield ev;
      }
    },
    interruptCommand,
  } as unknown as ExecChannel;
  return { channel, interruptCommand };
}

function sandboxWith(channel: ExecChannel) {
  const provider = stubProvider({ connectExec: vi.fn().mockResolvedValue(channel) });
  return new SandboxHandle("sb-1", "t", { provider, adapter: adapter() });
}

describe("the abort listener on exec()", () => {
  it("interrupts the command when the signal aborts while it runs", async () => {
    const { channel, interruptCommand } = channelWith([]);
    const sb = sandboxWith(channel);
    const controller = new AbortController();

    // A command that is still running when the signal fires. `started` resolves once the
    // listener is in place: the stream registers it just before it asks the channel to run.
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // eslint-disable-next-line typescript/require-await -- an async generator by signature
    channel.executeCommand = async function* () {
      started();
      await gate;
      yield exit0;
    };

    const handle = sb.exec("sleep 60", { signal: controller.signal, strict: false });
    await running;
    controller.abort();
    release();
    await handle;

    expect(interruptCommand).toHaveBeenCalledTimes(1);
  });

  it("is removed when the command finishes, so a later abort interrupts nothing", async () => {
    const { channel, interruptCommand } = channelWith([out("a\n"), exit0]);
    const sb = sandboxWith(channel);
    const controller = new AbortController();

    await sb.exec("echo a", { signal: controller.signal });
    controller.abort();

    expect(interruptCommand).not.toHaveBeenCalled();
  });

  it("is removed when the stream fails partway, so a later abort interrupts nothing", async () => {
    const { channel, interruptCommand } = channelWith([out("a\n"), out("b\n"), exit0], 1);
    const sb = sandboxWith(channel);
    const controller = new AbortController();

    await expect(
      Promise.resolve(sb.exec("echo a", { signal: controller.signal, strict: false })),
    ).rejects.toThrow("stream broke");
    // The next command on this channel is not the one this signal was for.
    controller.abort();

    expect(interruptCommand).not.toHaveBeenCalled();
  });
});
