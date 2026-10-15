import { errorCodeOf } from "@alineo-labs/errors";
import type { ExecChannel, SandboxProvider } from "@alineo-labs/provider";
import { ExecConnectionError } from "../errors";

/**
 * A channel to run commands in a sandbox, from its provider.
 *
 * The provider owns the wait: it resolves once the sandbox accepts a connection, and rejects with
 * `EXEC_NOT_READY` when it never does. That failure is re-thrown as `ExecConnectionError`, with
 * the cause, the attempt count, and the wait the provider recorded, because that class is the
 * one callers have been catching and it extends `WorkflowError`.
 */
export async function resolveExecChannel(
  provider: SandboxProvider,
  sandboxId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ExecChannel> {
  try {
    return await provider.connectExec(sandboxId, options);
  } catch (err) {
    if (errorCodeOf(err) !== "EXEC_NOT_READY") throw err;
    const details = (err as { details?: { attempts?: number; waitedMs?: number } }).details;
    throw new ExecConnectionError(sandboxId, {
      cause: (err as { cause?: unknown }).cause ?? err,
      attempts: details?.attempts,
      waitedMs: details?.waitedMs,
    });
  }
}
