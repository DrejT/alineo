import type { ControlClient } from "./control";
import type { NetworkPolicy, NetworkRule } from "./types";

/** Thrown for a non-2xx response from the egress sidecar's policy API. */
export class EgressClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EgressClientError";
  }
}

/** `GET /policy` response — the sidecar wraps the live policy in a status envelope. */
export interface EgressPolicyStatus {
  status?: string;
  mode?: string;
  enforcementMode?: string;
  policy?: NetworkPolicy | null;
}

/**
 * Talks directly to a sandbox's egress sidecar policy API (`PATCH`/`DELETE`/`GET /policy` on
 * port `18080`), resolved the same way `VaultClient` resolves the Credential Vault — via
 * `ControlClient.getEndpoint()`, against the sidecar's port instead of execd's `44772`.
 *
 * The policy API and the Credential Vault share one HTTP server and one auth check on the
 * sidecar: an `alineo init` sidecar runs token-less, so the `getEndpoint()` headers are all
 * that is needed. A hardened deployment that sets `OPENSANDBOX_EGRESS_TOKEN` would also need
 * an `OPENSANDBOX-EGRESS-AUTH` header — not wired here yet.
 *
 * Wire shapes verified against `opensandbox-group/OpenSandbox`'s
 * `components/egress/policy_server.go`:
 * - `PATCH /policy` — body is a JSON **array** of `{ action, target }`; merge semantics
 *   (an incoming rule replaces a same-`target` rule, others untouched, `defaultAction` kept).
 * - `DELETE /policy` — body is a JSON **array of target strings**; unmatched targets are
 *   silently ignored.
 * - `GET /policy` — returns `{ status, mode, enforcementMode, policy }`.
 *
 * Egress policy is sidecar-local runtime state: it does not survive the sidecar restarting
 * and is not restored by OpenSandbox's snapshot/checkpoint — callers that need a change to
 * outlive a `resume()`/`fork()` must re-apply it (`@alineo-labs/core` replays from the
 * ledger).
 */
export class EgressClient {
  private static readonly PORT = 18080;

  constructor(
    private readonly control: ControlClient,
    private readonly useServerProxy?: boolean,
  ) {}

  private async request<T>(sandboxId: string, method: string, body?: unknown): Promise<T> {
    const ep = await this.control.getEndpoint(sandboxId, EgressClient.PORT, this.useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const headers = {
      ...ep.headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const init = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };

    // Right after a sandbox (or fork/resume) is created, the egress sidecar can accept a
    // connection a beat before its request handling is wired up — surfacing as a proxy 500/502
    // or the sidecar's own 412 "not ready". Same retry `VaultClient` uses on `:18080`.
    const delaysMs = [0, 300, 600, 1200, 2400];
    let lastErr: EgressClientError | undefined;
    for (const delay of delaysMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await fetch(`${baseUrl}/policy`, init);
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      const text = await res.text().catch(() => "");
      lastErr = new EgressClientError(text || "egress policy API error", res.status);
      if (res.status !== 500 && res.status !== 502 && res.status !== 412) throw lastErr;
    }
    throw lastErr ?? new EgressClientError("egress policy API error", 500);
  }

  /** Merge `rules` into the live policy — an incoming rule replaces any rule with the same `target`. */
  patchRules(sandboxId: string, rules: NetworkRule[]): Promise<EgressPolicyStatus> {
    return this.request(sandboxId, "PATCH", rules);
  }

  /** Remove every rule whose `target` is in `targets`. Unknown targets are ignored. */
  deleteRules(sandboxId: string, targets: string[]): Promise<EgressPolicyStatus> {
    return this.request(sandboxId, "DELETE", targets);
  }

  /** The live policy plus the sidecar's status envelope. */
  getPolicy(sandboxId: string): Promise<EgressPolicyStatus> {
    return this.request(sandboxId, "GET");
  }
}
