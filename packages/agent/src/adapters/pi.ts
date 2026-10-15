import type { CredentialBinding, CredentialSource } from "@alineo-labs/core";
import type { HarnessAdapter, TurnInput } from "../harness/adapter";
import { PI_CAPABILITIES } from "../harness/capabilities";
import type { HarnessEvent } from "../harness/events";
import { fromPiEvent } from "../harness/pi-events";
import type { HarnessSandbox } from "../harness/sandbox";
import { BridgeHarness, readBuiltScript, rpcGet, rpcPost } from "../harness/bridge";
import { normalizePermissions } from "../permissions";
import type { AgentSpec, CredentialEnvBinding } from "../schema";
import type { PendingPermission, PermissionDecision } from "../types";
import type {
  AgentEvent,
  AgentStream,
  CompactResult,
  PiMessage,
  PiModel,
  PiSessionState,
  PiSlashCommand,
  SessionStats,
  ThinkingLevel,
} from "../types";

/** The subset of `SandboxHandle` that `PiAdapter` calls. Kept as an alias of `HarnessSandbox`. */
export type PiSandbox = HarnessSandbox;

/** Node CJS bridge script: written to `/alineo-bridge.js` and run with `node`. */
const bridgeScript = (): string => readBuiltScript("pi-bridge.cjs");
/** The permission-gate extension: written to `/alineo-permission-gate.js`, loaded by Pi via `-e`. */
const permissionGateScript = (): string => readBuiltScript("pi-permission-gate.mjs");

export function toShellExports(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `export ${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join("\n") + "\n"
  );
}

/**
 * Resolves plain string entries of `AgentSpec.env`, interpolating `${VAR}` from `process.env`.
 * Credential-bound entries (`{ credential, host, injection }`) are deliberately skipped here —
 * see `extractCredentialBindings()` — they never become a container env var at all.
 */
export function resolveEnv(
  env: Record<string, string | CredentialEnvBinding>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    result[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  return result;
}

/** Matches a `credential` value that is *only* a single `${VAR}` reference, nothing else. */
const SOLE_ENV_REF = /^\$\{([^}]+)\}$/;

/**
 * Pulls the credential-bound entries out of `AgentSpec.env` — the opt-in alternative to plain
 * env-var interpolation (see `AgentSpec.env`'s docs). Each entry's `credential` value is
 * interpolated the same way `resolveEnv()` interpolates plain strings; the resolved value is
 * only ever handed to `sb.credentials.set()`, never written into the container's environment.
 *
 * Also derives a `CredentialSource` for each: `credential: "${VAR}"` (the whole value, nothing
 * else around it) becomes `{ type: "env", varName: "VAR" }`, letting `fork()`/`resume()`
 * re-resolve it automatically later without needing a callback. Anything else — a literal
 * value, or `${VAR}` embedded in a larger string — becomes `{ type: "external" }`, since it
 * isn't reliably re-derivable the same way twice.
 */
export function extractCredentialBindings(
  env: Record<string, string | CredentialEnvBinding>,
): Array<{
  name: string;
  value: string;
  binding: CredentialBinding;
  source: CredentialSource;
  /** `"hold"` when the spec gated egress to this binding's host behind human approval. */
  approval?: "hold";
}> {
  const out: Array<{
    name: string;
    value: string;
    binding: CredentialBinding;
    source: CredentialSource;
    approval?: "hold";
  }> = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") continue;
    const soleRef = value.credential.match(SOLE_ENV_REF);
    out.push({
      name: key,
      value: value.credential.replace(
        /\$\{([^}]+)\}/g,
        (_, name: string) => process.env[name] ?? "",
      ),
      binding: { host: value.host, pathPrefix: value.pathPrefix, injection: value.injection },
      source: soleRef ? { type: "env", varName: soleRef[1] } : { type: "external" },
      ...(value.approval ? { approval: value.approval } : {}),
    });
  }
  return out;
}

/** Inverse of `toShellExports` — parses `/etc/alineo-env`'s content back into a plain object. */
export function parseShellExports(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /^export ([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return result;
}

export class PiAdapter extends BridgeHarness<AgentEvent> implements HarnessAdapter {
  readonly id = "pi";
  readonly capabilities = PI_CAPABILITIES;
  protected readonly bridgeScriptPath = "/alineo-bridge.js";
  /** Install Pi CLI and any spec packages. Slow — result is captured by checkpoint(). */
  async install(sb: PiSandbox, spec: AgentSpec): Promise<void> {
    const pkgs = [...new Set(spec.packages ?? [])].filter(
      (p) => p !== "nodejs_22" && p !== "nodejs",
    );
    if (pkgs.length > 0) {
      await sb.exec(
        `apt-get update -qq && apt-get install -y --no-install-recommends ${pkgs.join(" ")}`,
      );
    }
    const versionSpecifier = spec.harnessVersion?.trim();
    const pkg = versionSpecifier
      ? `@earendil-works/pi-coding-agent@${versionSpecifier}`
      : "@earendil-works/pi-coding-agent";
    await sb.exec(`npm install -g --ignore-scripts ${pkg}`);
  }

  /**
   * Write config files and the bridge script. Always runs on every start (fresh install
   * and snapshot resume alike) so env values, model/provider, and bridge code stay current.
   */
  async configure(
    sb: PiSandbox,
    spec: AgentSpec,
    resolvedEnv: Record<string, string>,
    opts?: { resume?: boolean },
  ): Promise<void> {
    const piConfig: Record<string, unknown> = {};
    if (spec.provider) piConfig.provider = spec.provider;
    // `model` is required by the spec schema, so Pi is never left to pick its own default.
    piConfig.model = spec.model;
    if (opts?.resume) piConfig.resume = true;
    const permissions = normalizePermissions(spec.permissions);
    if (permissions) piConfig.permissions = permissions;
    await sb.writeFile("/etc/alineo-pi.json", JSON.stringify(piConfig));
    await sb.writeFile("/etc/alineo-env", toShellExports(resolvedEnv));
    await sb.writeFile("/alineo-bridge.js", bridgeScript());
    if (permissions) await sb.writeFile("/alineo-permission-gate.js", permissionGateScript());
  }

  // --- HarnessAdapter (the bridge plumbing is in BridgeHarness) ---

  /** `start()` under its older name. */
  startBridge(sb: PiSandbox, unsetVars?: string[]): Promise<void> {
    return this.start(sb, { unsetVars });
  }

  /** `fork(entryId)` in the harness-neutral shape. Pi switches its own session in place. */
  async forkAt(messageId: string): Promise<{ sessionRef: string | null }> {
    await this.fork(messageId);
    return { sessionRef: null };
  }

  /** `reattach()` under its older name. */
  reattachBridge(sb: Pick<HarnessSandbox, "proxy">): Promise<void> {
    return this.reattach(sb);
  }

  /** `dispose()` under its older name. */
  disposeConnections(): void {
    this.dispose();
  }

  /**
   * One turn as harness events, ending in exactly one `done`. A failure (the bridge sends an
   * error frame, the stream times out or drops) becomes an `error` event then `done`: it
   * does not throw, and the `error` event's `raw` is the original error.
   *
   * A stream that ends with no `agent_end` is `aborted`. The bridge ends a stream that way
   * only when someone called `/abort`, from this process or another. A message sent with
   * `streamingBehavior` also ends with no `agent_end`: that is `completed`.
   */
  async *runTurn(input: TurnInput): AsyncGenerator<HarnessEvent> {
    let finished = false;
    try {
      const stream = this.prompt(input.message, {
        streamingBehavior: input.streamingBehavior,
        inactivityTimeoutMs: input.inactivityTimeoutMs,
      });
      for await (const ev of stream) {
        for (const out of fromPiEvent(ev)) {
          if (out.type === "done") finished = true;
          yield out;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      yield { type: "error", message, raw: e };
      yield { type: "done", reason: "error" };
      return;
    }
    if (!finished) {
      yield { type: "done", reason: input.streamingBehavior ? "completed" : "aborted" };
    }
  }

  // --- streaming ---

  prompt(
    message: string,
    opts?: { streamingBehavior?: "steer" | "followUp"; inactivityTimeoutMs?: number },
  ): AgentStream {
    return this.stream(
      "/prompt",
      { message, streamingBehavior: opts?.streamingBehavior },
      opts?.inactivityTimeoutMs,
    );
  }

  bash(command: string): AgentStream {
    return this.stream("/bash", { command });
  }

  // --- ack-only commands ---

  async steer(message: string): Promise<void> {
    const res = await fetch(`${this.bridgeUrl}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`steer failed: ${body.error ?? res.status}`);
    }
  }

  async followUp(message: string): Promise<void> {
    await rpcPost(this.bridgeUrl, "/follow-up", { message });
  }

  async newSession(): Promise<void> {
    await rpcPost(this.bridgeUrl, "/new-session");
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-thinking-level", { level });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-auto-compaction", { enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-auto-retry", { enabled });
  }

  async abortRetry(): Promise<void> {
    await rpcPost(this.bridgeUrl, "/abort-retry");
  }

  async abortBash(): Promise<void> {
    await rpcPost(this.bridgeUrl, "/abort-bash");
  }

  async getSessionStats(): Promise<SessionStats> {
    return rpcPost<SessionStats>(this.bridgeUrl, "/get-session-stats");
  }

  async getLastAssistantText(): Promise<string | null> {
    const r = await rpcPost<{ text: string | null }>(this.bridgeUrl, "/get-last-assistant-text");
    return r.text;
  }

  async getForkMessages(): Promise<{ entryId: string; text: string }[]> {
    const r = await rpcPost<{ messages: { entryId: string; text: string }[] }>(
      this.bridgeUrl,
      "/get-fork-messages",
    );
    return r.messages;
  }

  async getCommands(): Promise<PiSlashCommand[]> {
    const r = await rpcPost<{ commands: PiSlashCommand[] }>(this.bridgeUrl, "/get-commands");
    return r.commands;
  }

  async setSessionName(name: string): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-session-name", { name });
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-steering-mode", { mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await rpcPost(this.bridgeUrl, "/set-follow-up-mode", { mode });
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return rpcPost<{ path: string }>(
      this.bridgeUrl,
      "/export-html",
      outputPath !== undefined ? { outputPath } : {},
    );
  }

  // --- commands that return data ---

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return rpcPost(this.bridgeUrl, "/fork", { entryId });
  }

  async clone(): Promise<{ cancelled: boolean }> {
    return rpcPost(this.bridgeUrl, "/clone");
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return rpcPost(this.bridgeUrl, "/switch-session", { sessionPath });
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return rpcPost<PiModel>(this.bridgeUrl, "/set-model", { provider, modelId });
  }

  async cycleModel(): Promise<{
    model: PiModel;
    thinkingLevel: ThinkingLevel;
    isScoped: boolean;
  } | null> {
    return rpcPost(this.bridgeUrl, "/cycle-model");
  }

  async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
    return rpcPost(this.bridgeUrl, "/cycle-thinking-level");
  }

  async compact(customInstructions?: string): Promise<CompactResult> {
    return rpcPost<CompactResult>(this.bridgeUrl, "/compact", { customInstructions });
  }

  async getMessages(): Promise<PiMessage[]> {
    const data = await rpcGet<{ messages: PiMessage[] }>(this.bridgeUrl, "/messages");
    return data.messages;
  }

  async getAvailableModels(): Promise<PiModel[]> {
    const data = await rpcGet<{ models: PiModel[] }>(this.bridgeUrl, "/available-models");
    return data.models;
  }

  async getState(): Promise<PiSessionState> {
    return rpcGet<PiSessionState>(this.bridgeUrl, "/state");
  }

  // --- misc ---

  async reloadEnv(env: Record<string, string>): Promise<void> {
    await rpcPost(this.bridgeUrl, "/reload-env", { env });
    await this.waitReady();
  }

  async getLogs(): Promise<string> {
    const res = await fetch(`${this.bridgeUrl}/logs`);
    return res.text();
  }
}

// --- HTTP helpers ---
