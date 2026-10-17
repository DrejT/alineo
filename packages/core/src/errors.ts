import { AlineoError } from "@alineo-labs/errors";
import type { AlineoErrorOptions, ErrorCode } from "@alineo-labs/errors";

/**
 * Base class for all alineo workflow runtime errors.
 *
 * An {@link AlineoError}, so every subclass carries a stable `code`. A subclass that has not
 * been given a more specific code reports `INTERNAL`.
 */
export class WorkflowError extends AlineoError {
  constructor(message: string, code: ErrorCode = "INTERNAL", options?: AlineoErrorOptions) {
    super(code, message, options);
    this.name = "WorkflowError";
  }
}

/**
 * Thrown for sandbox lifecycle failures — failing to create, boot, or reach
 * `Running` state; being paused when an operation requires a live sandbox;
 * `fork()` being unsupported on this sandbox; or a snapshot operation failing.
 */
export class SandboxError extends WorkflowError {
  constructor(
    message: string,
    /** The sandbox ID, if one was assigned before the failure. */
    public readonly sandboxId?: string,
    code: ErrorCode = "INTERNAL",
    options?: AlineoErrorOptions,
  ) {
    super(message, code, {
      ...options,
      details: { ...(sandboxId ? { sandboxId } : {}), ...options?.details },
    });
    this.name = "SandboxError";
  }
}

/** What `ExecConnectionError` knows about the readiness probe that gave up. */
export interface ExecConnectionFailure {
  /** The last error the readiness probe saw. */
  cause?: unknown;
  /** How many probes ran. */
  attempts?: number;
  /** How long the probe waited in total, in milliseconds. */
  waitedMs?: number;
}

/**
 * Thrown when execd inside a sandbox never becomes ready within the retry window.
 * The sandbox is `Running` from the control plane's perspective, but the exec
 * daemon is not accepting connections.
 *
 * Code `EXEC_NOT_READY`. The message keeps its original leading text, and adds how long the
 * probe waited and the last error it saw, so a failure on a fresh machine says why.
 */
export class ExecConnectionError extends WorkflowError {
  constructor(
    public readonly sandboxId: string,
    failure: ExecConnectionFailure = {},
  ) {
    super(describeExecConnectionFailure(sandboxId, failure), "EXEC_NOT_READY", {
      cause: failure.cause,
      details: {
        sandboxId,
        ...(failure.attempts !== undefined ? { attempts: failure.attempts } : {}),
        ...(failure.waitedMs !== undefined ? { waitedMs: failure.waitedMs } : {}),
      },
    });
    this.name = "ExecConnectionError";
    this.attempts = failure.attempts;
    this.waitedMs = failure.waitedMs;
  }

  /** How many readiness probes ran before giving up. */
  readonly attempts?: number;
  /** How long the readiness probe waited in total, in milliseconds. */
  readonly waitedMs?: number;
}

function describeExecConnectionFailure(sandboxId: string, f: ExecConnectionFailure): string {
  let text = `execd not ready for sandbox ${sandboxId}`;
  if (f.attempts !== undefined && f.waitedMs !== undefined) {
    text += ` after ${f.attempts} attempts over ${(f.waitedMs / 1000).toFixed(0)}s`;
  }
  const reason = describeCause(f.cause);
  if (reason) text += `. Last error: ${reason}`;
  return text;
}

/** Text for a thrown value. Never throws: this runs inside an error constructor. */
function describeCause(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return undefined;
  }
}

/**
 * Thrown when a command exits with a non-zero exit code. Carries the exit
 * code and original command. For `SandboxHandle.exec()`, only thrown when `strict`
 * is enabled (the default — pass `{ strict: false }` to opt out). For
 * `BashSession.exec()` (a persistent session from `createSession()`), always
 * thrown on non-zero exit; there is no `strict` option for session execs.
 */
export class CommandError extends WorkflowError {
  constructor(
    public readonly exitCode: number,
    public readonly command: string,
    public readonly sandboxId: string,
  ) {
    super(`Command exited with code ${exitCode}: ${command}`, "COMMAND_FAILED", {
      details: { exitCode, sandboxId },
    });
    this.name = "CommandError";
  }
}

/**
 * Reserved for a per-step timeout mechanism — not currently thrown anywhere
 * in this codebase. `SandboxOptions.timeout`/`step.timeout` in `@alineo-labs/workflow`
 * bound sandbox container lifetime, which is a related but distinct concept.
 */
export class StepTimeoutError extends WorkflowError {
  constructor(
    public readonly stepId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Step "${stepId}" timed out after ${timeoutMs}ms`, "STEP_TIMEOUT", {
      details: { stepId, timeoutMs },
    });
    this.name = "StepTimeoutError";
  }
}
