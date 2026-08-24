/** Base class for all alineo workflow runtime errors. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
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
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Thrown when execd inside a sandbox never becomes ready within the retry window.
 * The sandbox is `Running` from the control plane's perspective, but the exec
 * daemon is not accepting connections.
 */
export class ExecConnectionError extends WorkflowError {
  constructor(public readonly sandboxId: string) {
    super(`execd not ready for sandbox ${sandboxId}`);
    this.name = "ExecConnectionError";
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
    super(`Command exited with code ${exitCode}: ${command}`);
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
    super(`Step "${stepId}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}
