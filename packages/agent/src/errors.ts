import { WorkflowError } from "@drej/core";

/**
 * Thrown when a prompt/bash SSE stream from a sandbox's Pi bridge goes quiet for longer than
 * the configured inactivity window -- no real `AgentEvent` (only the bridge's own `: ping`
 * keep-alives, which exist purely to defeat OpenSandbox's proxy idle-timeout and say nothing
 * about whether Pi itself is making progress) for that long. Previously this surfaced as an
 * indefinite hang with zero visibility: `sseStream()` had no timeout at all, so a genuinely
 * stuck Pi process (e.g. blocked in a credential refresh, or any other silent stall) blocked
 * every caller up the chain -- `Agent.prompt()`, `collectReply()`, `drejx fork --prompt` --
 * forever, with no error and no partial output.
 */
export class PromptTimeoutError extends WorkflowError {
  constructor(
    public readonly timeoutMs: number,
    public readonly bridgeUrl: string,
  ) {
    super(
      `Prompt produced no activity for ${timeoutMs / 1000}s (bridge ${bridgeUrl}) -- ` +
        `the underlying agent process may be stuck`,
    );
    this.name = "PromptTimeoutError";
  }
}
