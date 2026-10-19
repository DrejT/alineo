import { normalizePermissions } from "../permissions";
import type { AgentSpec } from "../schema";
import type { HarnessAdapter, TurnInput } from "../harness/adapter";
import { BridgeHarness, readBuiltScript, rpcPost } from "../harness/bridge";
import type { HarnessCapabilities } from "../harness/capabilities";
import type { HarnessEvent } from "../harness/events";
import type { HarnessSandbox } from "../harness/sandbox";
import { toShellExports } from "./pi";

/**
 * What Codex declares, each backed by an `app-server` method: `turn/steer`,
 * `thread/compact/start`, `thread/fork`, the approval requests, and reasoning deltas.
 * `followUp` and `setModel` are not wired.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  steer: true,
  followUp: false,
  resume: true,
  fork: true,
  compact: true,
  setModel: false,
  permissions: true,
  reasoning: true,
};

const CODEX_PACKAGE = "@openai/codex";

/** Node CJS bridge script: written to `/alineo-bridge.js` and run with `node`. */
const bridgeScript = (): string => readBuiltScript("codex-bridge.cjs");

/**
 * Codex, driven through `codex app-server` (JSON-RPC over stdio) by a bridge in the sandbox.
 * The bridge's frames are already `HarnessEvent`s, so `runTurn` forwards them.
 *
 * Fork granularity is the turn: every message of a turn has the turn id as its `messageId`,
 * because `thread/fork` takes `lastTurnId`.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export class CodexAdapter
  extends BridgeHarness<HarnessEvent & { requestId?: string }>
  implements HarnessAdapter
{
  readonly id = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  protected readonly bridgeScriptPath = "/alineo-bridge.js";

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
    const pkg = version ? `${CODEX_PACKAGE}@${version}` : CODEX_PACKAGE;
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
    await sb.writeFile("/etc/alineo-codex.json", JSON.stringify(config));
    await sb.writeFile("/etc/alineo-env", toShellExports(resolvedEnv));
    await sb.writeFile("/alineo-bridge.js", bridgeScript());
  }

  async *runTurn(input: TurnInput): AsyncGenerator<HarnessEvent> {
    let finished = false;
    try {
      for await (const frame of this.stream(
        "/prompt",
        { message: input.message },
        input.inactivityTimeoutMs,
      )) {
        yield frame;
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

  /** `turn/steer` into the running turn. Refused with `no turn in progress` between turns. */
  async steer(message: string): Promise<void> {
    await rpcPost(this.bridgeUrl, "/steer", { message });
  }

  async compact(): Promise<unknown> {
    await rpcPost(this.bridgeUrl, "/compact");
    return {};
  }

  /** `thread/fork`. `messageId` is a turn id, from a `message_start` of this adapter. */
  async forkAt(messageId: string): Promise<{ sessionRef: string | null }> {
    const r = await rpcPost<{ sessionRef: string }>(this.bridgeUrl, "/fork", {
      entryId: messageId,
    });
    return { sessionRef: r.sessionRef };
  }
}
