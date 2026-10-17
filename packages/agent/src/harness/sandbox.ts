import type { SandboxHandle, ExecOptions, ExecResult } from "@alineo-labs/core";

/**
 * The slice of `SandboxHandle` a harness adapter calls. `exec` only needs to be awaitable,
 * so callers (and tests) do not have to supply a full `ExecHandle`. It keeps the harness
 * layer testable with a stub.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export interface HarnessSandbox {
  exec(cmd: string, opts?: ExecOptions): PromiseLike<ExecResult>;
  proxy: SandboxHandle["proxy"];
  writeFile: SandboxHandle["writeFile"];
}
