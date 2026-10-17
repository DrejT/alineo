import { normalizePermissions } from "../permissions";
import type { AgentSpec } from "../schema";
import type { HarnessAdapter, TurnInput } from "../harness/adapter";
import { BridgeHarness, readBuiltScript, rpcPost } from "../harness/bridge";
import type { HarnessCapabilities } from "../harness/capabilities";
import type { HarnessEvent } from "../harness/events";
import type { HarnessSandbox } from "../harness/sandbox";
import { toShellExports } from "./pi";

/**
 * What Claude Code declares. Each `false` is a thing the bridge does not do today, not a
 * limit of the SDK: `steer` and `followUp` have no mid-turn injection in single-prompt mode,
 * `compact` and `setModel` are not wired, and `reasoning` needs extended thinking turned on.
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  steer: false,
  followUp: false,
  resume: true,
  fork: true,
  compact: false,
  setModel: false,
  permissions: true,
  reasoning: false,
};

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Node CJS bridge script: written to `/alineo-bridge.js` and run with `node`. */
const bridgeScript = (): string => readBuiltScript("claude-bridge.cjs");

/**
 * Claude Code, driven through the Claude Agent SDK by a bridge in the sandbox. The bridge's
 * frames are already `HarnessEvent`s, so `runTurn` forwards them.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export class ClaudeCodeAdapter
  extends BridgeHarness<HarnessEvent & { requestId?: string }>
  implements HarnessAdapter
{
  readonly id = "claude-code";
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  protected readonly bridgeScriptPath = "/alineo-bridge.js";

  /** Install the Agent SDK globally, and any spec packages. Slow: a snapshot captures it. */
  async install(sb: HarnessSandbox, spec: AgentSpec): Promise<void> {
    const pkgs = [...new Set(spec.packages ?? [])].filter(
      (p) => p !== "nodejs_22" && p !== "nodejs",
    );
    if (pkgs.length > 0) {
      await sb.exec(
        `apt-get update -qq && apt-get install -y --no-install-recommends ${pkgs.join(" ")}`,
      );
    }
    const version = spec.harnessVersion?.trim();
    const pkg = version ? `${SDK_PACKAGE}@${version}` : SDK_PACKAGE;
    // The platform binary comes through an optional dependency, so scripts stay off.
    await sb.exec(`npm install -g --ignore-scripts ${pkg}`);
  }

  async configure(
    sb: HarnessSandbox,
    spec: AgentSpec,
    resolvedEnv: Record<string, string>,
    opts?: { resume?: boolean },
  ): Promise<void> {
    const config: Record<string, unknown> = { model: spec.model };
    if (opts?.resume) config.resume = true;
    const permissions = normalizePermissions(spec.permissions);
    if (permissions) config.permissions = permissions;
    await sb.writeFile("/etc/alineo-claude.json", JSON.stringify(config));
    await sb.writeFile("/etc/alineo-env", toShellExports(resolvedEnv));
    await sb.writeFile("/alineo-bridge.js", bridgeScript());
  }

  /**
   * One turn as harness events. The bridge already speaks `HarnessEvent`, so the frames pass
   * through. A bridge error frame, timeout or dropped stream is an `error` then `done`, and
   * does not throw. A stream that ends with no `done` is `aborted`.
   */
  async *runTurn(input: TurnInput): AsyncGenerator<HarnessEvent> {
    let finished = false;
    try {
      for await (const frame of this.stream(
        "/prompt",
        { message: input.message },
        input.inactivityTimeoutMs,
      )) {
        yield frame;
        // `done` is the last event of a turn. Anything after it is dropped.
        if (frame.type === "done") {
          finished = true;
          return;
        }
      }
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e), raw: e };
      yield { type: "done", reason: "error" };
      return;
    }
    if (!finished) yield { type: "done", reason: "aborted" };
  }

  async forkAt(messageId: string): Promise<{ sessionRef: string | null }> {
    const r = await rpcPost<{ sessionRef: string }>(this.bridgeUrl, "/fork", {
      entryId: messageId,
    });
    return { sessionRef: r.sessionRef };
  }
}
