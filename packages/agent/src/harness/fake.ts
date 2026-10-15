import type { AgentSpec } from "../schema";
import type { PendingPermission, PermissionDecision } from "../types";
import type { HarnessAdapter, TurnInput } from "./adapter";
import type { HarnessCapabilities } from "./capabilities";
import type { HarnessEvent } from "./events";
import type { HarnessSandbox } from "./sandbox";

/** What a `FakeHarness` does on its next turn. */
export type FakeScenario =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; result: string }
  /** Starts, then waits until `abort()`. */
  | { kind: "hang" }
  | { kind: "fail"; message: string }
  /** Asks for permission to run `tool`, then runs it only if the answer allows. */
  | { kind: "permission"; tool: string; target: string };

const ALL_ON: HarnessCapabilities = {
  steer: true,
  followUp: true,
  resume: true,
  fork: true,
  compact: true,
  setModel: true,
  permissions: true,
  reasoning: true,
};

/**
 * A harness that runs no process: it plays a `FakeScenario` in memory. For tests that need
 * a `HarnessAdapter` and for proving the conformance suite itself is satisfiable. It is not
 * registered, so a spec cannot select it.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export class FakeHarness implements HarnessAdapter {
  readonly id = "fake";
  readonly capabilities: HarnessCapabilities;
  /** Lifecycle calls in order, for assertions. */
  readonly calls: string[] = [];
  /** Messages `steer` and `followUp` accepted. */
  readonly received: string[] = [];

  steer?: (message: string) => Promise<void>;
  followUp?: (message: string) => Promise<void>;
  forkAt?: (messageId: string) => Promise<{ sessionRef: string | null }>;

  private turnActive = false;
  private release: (() => void) | null = null;
  private pending = new Map<
    string,
    { info: PendingPermission; settle: (d: PermissionDecision) => void }
  >();

  constructor(
    private readonly scenario: FakeScenario,
    capabilities: Partial<HarnessCapabilities> = {},
  ) {
    this.capabilities = { ...ALL_ON, ...capabilities };
    if (this.capabilities.steer) {
      this.steer = (message) => {
        if (!this.turnActive) return Promise.reject(new Error("no turn in progress"));
        this.received.push(message);
        return Promise.resolve();
      };
    }
    if (this.capabilities.fork) {
      this.forkAt = (messageId) => {
        this.received.push(`fork:${messageId}`);
        return Promise.resolve({ sessionRef: `fake-fork-of-${messageId}` });
      };
    }
    if (this.capabilities.followUp) {
      this.followUp = (message) => {
        this.received.push(message);
        return Promise.resolve();
      };
    }
  }

  install(_sb: HarnessSandbox, _spec: AgentSpec): Promise<void> {
    this.calls.push("install");
    return Promise.resolve();
  }
  configure(): Promise<void> {
    this.calls.push("configure");
    return Promise.resolve();
  }
  start(): Promise<void> {
    this.calls.push("start");
    return Promise.resolve();
  }
  reattach(): Promise<void> {
    this.calls.push("reattach");
    return Promise.resolve();
  }
  waitReady(): Promise<void> {
    this.calls.push("waitReady");
    return Promise.resolve();
  }

  async *runTurn(_input: TurnInput): AsyncGenerator<HarnessEvent> {
    this.turnActive = true;
    const s = this.scenario;
    try {
      yield { type: "run_start" };
      switch (s.kind) {
        case "text":
          yield { type: "text", text: s.text };
          break;
        case "tool":
          yield { type: "tool_start", toolCallId: "t1", toolName: s.toolName, args: {} };
          yield {
            type: "tool_end",
            toolCallId: "t1",
            toolName: s.toolName,
            result: s.result,
            isError: false,
          };
          break;
        case "fail":
          yield { type: "error", message: s.message };
          yield { type: "done", reason: "error" };
          return;
        case "hang": {
          await new Promise<void>((resolve) => {
            this.release = resolve;
          });
          yield { type: "done", reason: "aborted" };
          return;
        }
        case "permission": {
          const requestId = "perm-1";
          const info: PendingPermission = {
            requestId,
            tool: s.tool,
            target: s.target,
            title: `Run ${s.tool}: ${s.target}`,
            since: Date.now(),
          };
          const decided = new Promise<PermissionDecision>((settle) => {
            this.pending.set(requestId, { info, settle });
          });
          yield {
            type: "permission_request",
            requestId,
            tool: s.tool,
            target: s.target,
            title: info.title,
          };
          const decision = await decided;
          this.pending.delete(requestId);
          yield { type: "permission_resolved", requestId, decision };
          if (decision.kind === "reject") {
            yield { type: "text", text: "The call was declined." };
          } else {
            yield {
              type: "tool_start",
              toolCallId: "t1",
              toolName: s.tool,
              args: { target: s.target },
            };
            yield {
              type: "tool_end",
              toolCallId: "t1",
              toolName: s.tool,
              result: "ok",
              isError: false,
            };
          }
          break;
        }
      }
      yield { type: "done", reason: "completed" };
    } finally {
      this.turnActive = false;
    }
  }

  abort(): Promise<void> {
    this.release?.();
    this.release = null;
    return Promise.resolve();
  }

  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return Promise.reject(new Error("no such pending permission"));
    p.settle(decision);
    return Promise.resolve();
  }

  listPendingPermissions(): Promise<PendingPermission[]> {
    return Promise.resolve([...this.pending.values()].map((p) => p.info));
  }

  dispose(): void {
    this.calls.push("dispose");
  }
}
