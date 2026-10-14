import { describe, expect, it, vi } from "vitest";
import { AlineoError } from "@alineo-labs/errors";
import type { ExecChannel } from "@alineo-labs/provider";
import { resolveExecChannel } from "../src/sandbox/resolve.ts";
import { ExecConnectionError, WorkflowError } from "../src/errors.ts";
import { stubProvider } from "./provider-stub.ts";

const channel = { executeCommand: vi.fn() } as unknown as ExecChannel;

describe("resolveExecChannel", () => {
  it("returns the channel the provider connected", async () => {
    const provider = stubProvider({ connectExec: vi.fn().mockResolvedValue(channel) });

    expect(await resolveExecChannel(provider, "sb-1")).toBe(channel);
    expect(provider.connectExec).toHaveBeenCalledWith("sb-1");
  });

  it("re-throws EXEC_NOT_READY as ExecConnectionError, keeping the cause and the numbers", async () => {
    const probe = new Error("connect ECONNREFUSED 10.0.0.5");
    const provider = stubProvider({
      connectExec: vi.fn().mockRejectedValue(
        new AlineoError("EXEC_NOT_READY", "execd not ready", {
          cause: probe,
          details: { sandboxId: "sb-9", attempts: 46, waitedMs: 81_000 },
        }),
      ),
    });

    const err = await resolveExecChannel(provider, "sb-9").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExecConnectionError);
    expect(err).toBeInstanceOf(WorkflowError);
    const failure = err as ExecConnectionError;
    expect(failure.code).toBe("EXEC_NOT_READY");
    expect(failure.retryable).toBe(true);
    expect(failure.sandboxId).toBe("sb-9");
    expect(failure.attempts).toBe(46);
    expect(failure.waitedMs).toBe(81_000);
    expect(failure.cause).toBe(probe);
    // The message keeps its old leading text, and now says how long it waited and what it saw.
    expect(failure.message).toBe(
      "execd not ready for sandbox sb-9 after 46 attempts over 81s. " +
        "Last error: connect ECONNREFUSED 10.0.0.5",
    );
    expect(failure.hint).toContain("execd_image");
  });

  it("passes any other failure through untouched", async () => {
    const boom = new AlineoError("SANDBOX_NOT_FOUND", "gone");
    const provider = stubProvider({ connectExec: vi.fn().mockRejectedValue(boom) });

    await expect(resolveExecChannel(provider, "sb-1")).rejects.toBe(boom);
  });
});

describe("ExecConnectionError", () => {
  it("is a plain message when nothing about the probe is known", () => {
    const err = new ExecConnectionError("sb-1");
    expect(err.message).toBe("execd not ready for sandbox sb-1");
    expect(err.code).toBe("EXEC_NOT_READY");
    expect(err.attempts).toBeUndefined();
  });
});
