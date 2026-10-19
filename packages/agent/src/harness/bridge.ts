import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BridgeDisconnectedError, PromptTimeoutError } from "../errors";
import type { PendingPermission, PermissionDecision } from "../types";
import type { HarnessSandbox } from "./sandbox";

/**
 * Read a script the build produced (`dist/<name>`), to write into a sandbox. Resolved beside
 * this module first (the published package, where `index.mjs` sits in `dist/`), then in the
 * package's own `dist/` (running from `src/` in dev and tests). Read lazily, so importing
 * this module does not need a build.
 */
export function readBuiltScript(name: string): string {
  const candidates = [
    new URL(`./${name}`, import.meta.url),
    new URL(`../../dist/${name}`, import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return readFileSync(fileURLToPath(url), "utf8");
    } catch {
      // try the next location
    }
  }
  throw new Error(`alineo: ${name} not found. Run \`bun run build\` in packages/agent.`);
}

/**
 * What every harness that runs behind an in-sandbox HTTP bridge shares: finding the bridge,
 * waiting for it, streaming a turn from it, closing the streams it leaves open, and the
 * permission endpoints. A subclass adds its own install, configure and turn mapping.
 *
 * The bridge contract (what a bridge script must serve):
 * - `GET /health` returns `{ ok: true }` once it can take a turn.
 * - `POST /abort` ends the running turn.
 * - `POST /permission-response` takes `{ requestId, decision }`.
 * - `GET /pending-permissions` returns `{ ok, data: { pending: PendingPermission[] } }`.
 * - A turn is an SSE stream of JSON frames, ended by `data: [DONE]`. A frame `{ error }` fails it.
 */
export abstract class BridgeHarness<E extends { type?: string; requestId?: string }> {
  /** The path the bridge script is written to in the sandbox. */
  protected abstract readonly bridgeScriptPath: string;
  private _bridgeUrl: string | null = null;
  /**
   * Controllers for streams `sseStream` deliberately left open (its early return on `[DONE]`,
   * to dodge the same OpenSandbox proxy behavior `ExecClient.parseSSE` documents).
   * `AbortController.abort()`, not `reader.cancel()`: Bun's `fetch()` tears down the
   * underlying connection reliably on an abort signal, but was observed to leave the socket
   * referenced after `reader.cancel()` on the bridge's long-lived, heartbeat-pinged
   * connections.
   *
   * Known limitation: a script making two or more such calls before close() can still hang
   * even though every controller here aborts cleanly on the client side. Root cause is the
   * same class of bug as opensandbox-group/OpenSandbox#1277 (execd's chunked-SSE termination
   * confusing the control server's proxy relay). Tracked in our own #189.
   */
  protected readonly pendingStreams = new Set<AbortController>();

  abstract readonly id: string;

  protected get bridgeUrl(): string {
    if (!this._bridgeUrl) throw new Error(`${this.id}: bridge not started`);
    return this._bridgeUrl;
  }

  /**
   * Start the bridge. `unsetVars`, when given, is prefixed as `unset A B C; ` on the *same*
   * exec command that starts `node`, which a forked sandbox needs: the container's OS-level
   * env still carries whatever the parent had baked in at snapshot time. A plain
   * `sb.exec("unset ...")` beforehand would not work: each `exec()` is its own shell session.
   */
  async start(sb: HarnessSandbox, opts?: { unsetVars?: string[] }): Promise<void> {
    const vars = opts?.unsetVars;
    const prefix = vars && vars.length > 0 ? `unset ${vars.join(" ")}; ` : "";
    await sb.exec(`${prefix}node ${this.bridgeScriptPath} &`);
    const { url } = await sb.proxy(3001);
    this._bridgeUrl = url;
  }

  /**
   * Rebind to a bridge that is already running. `sb.proxy(port)` is a pure URL lookup: it
   * starts nothing, so nothing in the sandbox changes. Follow with `waitReady()`, because the
   * container can be alive while the bridge process inside it is not.
   */
  async reattach(sb: Pick<HarnessSandbox, "proxy">): Promise<void> {
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

  /**
   * Force-close the streams left open (see `pendingStreams`). They sit ESTABLISHED, keeping
   * the event loop alive, because the bridge's own `: ping` heartbeat means no server-side
   * timeout ever ends a dangling one. Call once, as the agent closes.
   */
  dispose(): void {
    for (const controller of this.pendingStreams) controller.abort();
    this.pendingStreams.clear();
  }

  async abort(): Promise<void> {
    await rpcPost(this.bridgeUrl, "/abort");
  }

  async resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await rpcPost(this.bridgeUrl, "/permission-response", { requestId, decision });
  }

  async listPendingPermissions(): Promise<PendingPermission[]> {
    const r = await rpcGet<{ pending: PendingPermission[] }>(
      this.bridgeUrl,
      "/pending-permissions",
    );
    return r.pending;
  }

  /** Open a turn stream on the bridge. */
  protected stream(path: string, body: unknown, inactivityTimeoutMs?: number): AsyncGenerator<E> {
    return sseStream<E>(this.bridgeUrl, path, body, this.pendingStreams, inactivityTimeoutMs);
  }
}

export async function rpcPost<T = null>(
  bridgeUrl: string,
  path: string,
  body: unknown = {},
): Promise<T> {
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

export async function rpcGet<T>(bridgeUrl: string, path: string): Promise<T> {
  const res = await fetch(`${bridgeUrl}${path}`);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  const payload = (await res.json()) as { ok: boolean; data?: T };
  return payload.data as T;
}

/**
 * How long to tolerate zero real `AgentEvent`s before treating the stream as stuck. The
 * bridge's own `: ping` keep-alive (every 3s, see bridge/pi-bridge.ts's `startHeartbeat`) exists only
 * to defeat OpenSandbox's proxy idle-timeout -- it keeps `reader.read()` resolving regardless
 * of whether Pi itself is making progress, so this can't just be "no read() in N seconds". The
 * timer below is instead reset only when a real event is parsed and yielded (or `[DONE]`
 * arrives), so a connection that's alive-but-silent for this long still times out.
 *
 * 60s (the original default) was too tight for a common, legitimate pattern: Pi's own `bash`
 * tool is not incrementally streamed (see the `bash()` doc comment in session-control.ts), so
 * a single tool call that spins up a whole child sandbox -- e.g. a master session running
 * `alineo spawn` on itself, as in examples/rlm-repo-fanout -- produces zero AgentEvents for as
 * long as that tool call takes, which regularly exceeded 60s (child sandbox provisioning +
 * Pi CLI install alone routinely took 30-150s+ in practice) and tripped this timeout mid-run
 * even though the session was making real progress. Raised to 3 minutes as a still-bounded
 * but realistic ceiling for that pattern; pass `inactivityTimeoutMs` explicitly to `prompt()`
 * for sessions that need something tighter or looser.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 180_000;

export async function* sseStream<E extends { type?: string; requestId?: string }>(
  bridgeUrl: string,
  path: string,
  body: unknown,
  pendingStreams: Set<AbortController>,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
): AsyncGenerator<E> {
  const controller = new AbortController();
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
    // Without this, Bun pools this connection for reuse across the next prompt()/bash()
    // call to the same bridge origin -- a pooled keep-alive socket outlives any individual
    // request's own abort(), so a second stream on the same connection can keep the
    // process alive even after both streams' controllers have been aborted.
    keepalive: false,
  });
  if (!res.ok || !res.body) throw new Error(`Bridge ${path} error: ${res.status}`);

  pendingStreams.add(controller);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEventAt = Date.now();
  // A `permission_request` can sit unanswered for as long as a human takes to decide, with
  // no events flowing meanwhile. While any are outstanding, the inactivity timeout is
  // suspended — the bridge's own PERMISSION_TIMEOUT_MS is the backstop there.
  const pendingPermissions = new Set<string>();
  // Only a genuine server-signalled EOF (`done: true`) counts as reaching the natural end --
  // both the `[DONE]` early-return below and any thrown error (timeout, malformed payload,
  // bridge-reported error) leave the connection mid-stream, same as a natural EOF's opposite.
  let reachedNaturalEnd = false;

  try {
    while (true) {
      const awaitingHuman = pendingPermissions.size > 0;
      const remainingMs = inactivityTimeoutMs - (Date.now() - lastEventAt);
      if (!awaitingHuman && remainingMs <= 0) {
        throw new PromptTimeoutError(inactivityTimeoutMs, bridgeUrl);
      }

      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          setTimeout(
            () => {
              resolve("timeout");
            },
            awaitingHuman ? inactivityTimeoutMs : Math.max(remainingMs, 1),
          );
        }),
      ]);
      if (result === "timeout") {
        if (pendingPermissions.size > 0) {
          lastEventAt = Date.now(); // reset the clock; a human is still deciding
          continue;
        }
        throw new PromptTimeoutError(inactivityTimeoutMs, bridgeUrl);
      }

      const { done, value } = result;
      if (done) {
        // A raw TCP-level EOF, not the bridge's own `[DONE]` sentinel (that branch below
        // returns before ever reaching here) -- the connection closed without Pi ever
        // signalling the turn was actually finished. Indistinguishable from a legitimate
        // finish at the reader level, so it has to be surfaced explicitly rather than treated
        // as a silent success (M2.1).
        reachedNaturalEnd = true;
        throw new BridgeDisconnectedError(bridgeUrl);
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // split() on a string always yields at least one element
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          // Deliberately don't abort the connection here -- same reasoning as ExecClient's
          // parseSSE (packages/opensandbox/src/exec.ts): tearing down mid-stream through the
          // bridge's proxied connection can upset the relay. Leave `controller` registered in
          // pendingStreams for BridgeHarness.dispose() to force shut at agent.close()
          // time instead, once nobody cares if the proxy's relay errors out.
          return;
        }
        const raw = JSON.parse(payload) as E & { error?: string };
        if (raw.error) throw new Error(`Bridge error: ${raw.error}`);
        if (raw.requestId !== undefined) {
          if (raw.type === "permission_request") pendingPermissions.add(raw.requestId);
          else if (raw.type === "permission_resolved") pendingPermissions.delete(raw.requestId);
        }
        lastEventAt = Date.now();
        yield raw;
      }
    }
  } finally {
    if (reachedNaturalEnd) {
      pendingStreams.delete(controller);
      reader.releaseLock();
    }
  }
}
