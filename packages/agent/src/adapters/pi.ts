import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "@alineo-labs/core";
import { PromptTimeoutError } from "../errors";
import type { AgentSpec } from "../schema";
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

// Node.js CJS bridge script — written into the sandbox at /alineo-bridge.js and run with `node`.
// Wraps `pi --mode rpc` in an HTTP server so the host can communicate bidirectionally
// without needing interactive stdin support from the sandbox exec API.
//
// Lives in pi-bridge.js as a real file (lint/format-checked on its own) rather than a
// template-literal string, and is read relative to this module's own location — works
// identically in dev (src/adapters/) and in the published package, where tsdown's `copy`
// config places it alongside dist/index.mjs (see tsdown.config.ts). A bundler-native text
// import (`with { type: "text" }` / `?raw`) would be cleaner but neither is understood by
// rolldown, the bundler tsdown uses for this package's actual publish build.
const BRIDGE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./pi-bridge.js", import.meta.url)),
  "utf8",
);

export function toShellExports(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `export ${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join("\n") + "\n"
  );
}

export function resolveEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  return result;
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

export class PiAdapter {
  private _bridgeUrl: string | null = null;

  private get bridgeUrl(): string {
    if (!this._bridgeUrl) throw new Error("PiAdapter: bridge not started");
    return this._bridgeUrl;
  }

  /** Install Pi CLI and any spec packages. Slow — result is captured by checkpoint(). */
  async install(sb: Sandbox, spec: AgentSpec): Promise<void> {
    const pkgs = [...new Set(spec.packages ?? [])].filter(
      (p) => p !== "nodejs_22" && p !== "nodejs",
    );
    if (pkgs.length > 0) {
      await sb.exec(
        `apt-get update -qq && apt-get install -y --no-install-recommends ${pkgs.join(" ")}`,
      );
    }
    const versionSpecifier = spec.cliVersion?.trim();
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
    sb: Sandbox,
    spec: AgentSpec,
    resolvedEnv: Record<string, string>,
    opts?: { resume?: boolean },
  ): Promise<void> {
    const piConfig: Record<string, unknown> = {};
    if (spec.provider) piConfig.provider = spec.provider;
    if (spec.model) piConfig.model = spec.model;
    if (opts?.resume) piConfig.resume = true;
    await sb.writeFile("/etc/alineo-pi.json", JSON.stringify(piConfig));
    await sb.writeFile("/etc/alineo-env", toShellExports(resolvedEnv));
    await sb.writeFile("/alineo-bridge.js", BRIDGE_SCRIPT);
  }

  /**
   * Start the bridge. `unsetVars`, when given, is prefixed as `unset A B C; ` on the
   * *same* exec command that starts `node` — required for `Agent.spawn()`'s forked
   * sandboxes, where the container's OS-level env still carries whatever the parent
   * had baked into it at snapshot time (`env` passed to `createSandbox` at fork time
   * has no effect on this — verified live, see `plans/alineo-rlm-substrate.md`). A
   * plain `sb.exec("unset ...")` beforehand would not work: `unset` only clears the
   * shell session it runs in, and each `exec()` call is its own session — it has to
   * be part of the exact command that spawns the bridge process so the bridge (and
   * everything it in turn spawns, including Pi itself) inherits the already-clean env.
   */
  async startBridge(sb: Sandbox, unsetVars?: string[]): Promise<void> {
    const prefix = unsetVars && unsetVars.length > 0 ? `unset ${unsetVars.join(" ")}; ` : "";
    await sb.exec(`${prefix}node /alineo-bridge.js &`);
    const { url } = await sb.proxy(3001);
    this._bridgeUrl = url;
  }

  async waitReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.bridgeUrl}/health`);
        if (res.ok) {
          const body = (await res.json()) as { ok: boolean };
          if (body.ok) return;
        }
      } catch {
        // bridge not reachable yet
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    throw new Error(`alineo-bridge did not become ready within ${timeoutMs / 1_000}s`);
  }

  // --- streaming ---

  prompt(
    message: string,
    opts?: { streamingBehavior?: "steer" | "followUp"; inactivityTimeoutMs?: number },
  ): AgentStream {
    return sseStream(
      this.bridgeUrl,
      "/prompt",
      { message, streamingBehavior: opts?.streamingBehavior },
      opts?.inactivityTimeoutMs,
    );
  }

  bash(command: string): AgentStream {
    return sseStream(this.bridgeUrl, "/bash", { command });
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

  async abort(): Promise<void> {
    await rpcPost(this.bridgeUrl, "/abort");
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

async function rpcPost<T = null>(bridgeUrl: string, path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${path} failed: ${err.error ?? res.status}`);
  }
  const payload = (await res.json()) as { ok: boolean; data?: T };
  return payload.data as T;
}

async function rpcGet<T>(bridgeUrl: string, path: string): Promise<T> {
  const res = await fetch(`${bridgeUrl}${path}`);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  const payload = (await res.json()) as { ok: boolean; data?: T };
  return payload.data as T;
}

/**
 * How long to tolerate zero real `AgentEvent`s before treating the stream as stuck. The
 * bridge's own `: ping` keep-alive (every 3s, see pi-bridge.js's `startHeartbeat`) exists only
 * to defeat OpenSandbox's proxy idle-timeout -- it keeps `reader.read()` resolving regardless
 * of whether Pi itself is making progress, so this can't just be "no read() in N seconds". The
 * timer below is instead reset only when a real event is parsed and yielded (or `[DONE]`
 * arrives), so a connection that's alive-but-silent for this long still times out.
 *
 * 60s (the original default) was too tight for a common, legitimate pattern: Pi's own `bash`
 * tool is not incrementally streamed (see the `bash()` doc comment in session-control.ts), so
 * a single tool call that spins up a whole child sandbox -- e.g. a master session running
 * `alineo fork` on itself, as in examples/rlm-repo-fanout -- produces zero AgentEvents for as
 * long as that tool call takes, which regularly exceeded 60s (child sandbox provisioning +
 * Pi CLI install alone routinely took 30-150s+ in practice) and tripped this timeout mid-run
 * even though the session was making real progress. Raised to 3 minutes as a still-bounded
 * but realistic ceiling for that pattern; pass `inactivityTimeoutMs` explicitly to `prompt()`
 * for sessions that need something tighter or looser.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 180_000;

async function* sseStream(
  bridgeUrl: string,
  path: string,
  body: unknown,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
): AgentStream {
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Bridge ${path} error: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEventAt = Date.now();

  try {
    while (true) {
      const remainingMs = inactivityTimeoutMs - (Date.now() - lastEventAt);
      if (remainingMs <= 0) throw new PromptTimeoutError(inactivityTimeoutMs, bridgeUrl);

      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remainingMs)),
      ]);
      if (result === "timeout") throw new PromptTimeoutError(inactivityTimeoutMs, bridgeUrl);

      const { done, value } = result;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        const raw = JSON.parse(payload) as AgentEvent & { error?: string };
        if (raw.error) throw new Error(`Bridge error: ${raw.error}`);
        lastEventAt = Date.now();
        yield raw as AgentEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
