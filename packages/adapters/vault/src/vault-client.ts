import type { ControlClient } from "@alineo-labs/opensandbox";

/** Thrown for a non-2xx response from the egress sidecar's Credential Vault API. */
export class VaultClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VaultClientError";
  }
}

/** Wire shape for one binding, sent to/received from the egress sidecar's `/credential-vault`. */
export interface VaultBinding {
  name: string;
  /** Present on create/patch requests; never returned by `list()`. */
  value?: string;
  host: string;
  pathPrefix?: string;
  injection:
    | { type: "header"; name: string }
    | { type: "query"; param: string }
    | { type: "path"; segment: string };
}

/**
 * Talks directly to a sandbox's egress sidecar Credential Vault management API (port `18080`),
 * resolved the same way `resolveExecClient()` resolves execd's endpoint — via
 * `ControlClient.getEndpoint()` — but against the sidecar's port instead of execd's `44772`.
 *
 * The vault is sidecar-local, runtime-only state (OSEP-0012): it does not survive the sidecar
 * restarting or being rescheduled, and isn't restored by OpenSandbox's own snapshot/checkpoint
 * mechanism. `OpenSandboxCredentialBroker` (this package's `CredentialBroker` implementation)
 * builds on top of this client — most callers should use that rather than `VaultClient` directly.
 *
 * NOTE: request/response schema is sourced from OpenSandbox's OSEP-0012 docs, not yet verified
 * against a live server from this repo — confirm before this ships (see plans/credential-injection.md).
 */
export class VaultClient {
  private static readonly PORT = 18080;

  constructor(private readonly control: ControlClient) {}

  private async request<T>(
    sandboxId: string,
    method: string,
    path: string,
    useServerProxy: boolean | undefined,
    body?: unknown,
  ): Promise<T> {
    const ep = await this.control.getEndpoint(sandboxId, VaultClient.PORT, useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...ep.headers,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VaultClientError(text || "Credential Vault API error", res.status);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  create(sandboxId: string, binding: VaultBinding, useServerProxy?: boolean): Promise<void> {
    return this.request(sandboxId, "POST", "/credential-vault", useServerProxy, binding);
  }

  patch(
    sandboxId: string,
    name: string,
    changes: Partial<Omit<VaultBinding, "name">>,
    useServerProxy?: boolean,
  ): Promise<void> {
    return this.request(
      sandboxId,
      "PATCH",
      `/credential-vault/${encodeURIComponent(name)}`,
      useServerProxy,
      changes,
    );
  }

  remove(sandboxId: string, name: string, useServerProxy?: boolean): Promise<void> {
    return this.request(
      sandboxId,
      "DELETE",
      `/credential-vault/${encodeURIComponent(name)}`,
      useServerProxy,
    );
  }

  /** Returns binding metadata only — the sidecar never echoes `value` back on a list call. */
  list(sandboxId: string, useServerProxy?: boolean): Promise<Omit<VaultBinding, "value">[]> {
    return this.request(sandboxId, "GET", "/credential-vault", useServerProxy);
  }
}
