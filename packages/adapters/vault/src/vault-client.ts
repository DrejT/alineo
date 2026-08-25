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

/**
 * A credential's value, as the sidecar's Go source (`components/egress/pkg/credentialvault`)
 * accepts it. `inline` is the only source type registered by default — the sidecar's
 * `SourceRegistry` supports others (e.g. vault-backed) but nothing this package emits uses them.
 */
export type WireCredentialSource = { type: "inline"; value: string };

export interface WireCredential {
  name: string;
  source: WireCredentialSource;
}

export interface WireMatch {
  hosts: string[];
  schemes?: string[];
  methods?: string[];
  paths?: string[];
}

export interface WireCustomHeaderEntry {
  name: string;
  credential: string;
}

export interface WireSubstitution {
  credential: string;
  placeholder: string;
  in: Array<"path" | "query" | "header" | "body">;
}

/**
 * `bearer`/`basic` inject `Authorization: Bearer|Basic <value>` (header name is fixed).
 * `apiKey` injects `<value>` under a caller-chosen header name — this is what alineo's
 * `{ type: "header", name }` binding maps to, since it carries the value unprefixed.
 * `customHeaders`/`passthrough`/substitutions exist on the wire but nothing in this package
 * produces them yet.
 */
export interface WireAuth {
  type: "bearer" | "basic" | "apiKey" | "customHeaders" | "passthrough";
  credential?: string;
  name?: string;
  headers?: WireCustomHeaderEntry[];
  substitutions?: WireSubstitution[];
}

export interface WireBinding {
  name: string;
  match: WireMatch;
  auth: WireAuth;
}

export interface WireCredentialMetadata {
  name: string;
  sourceType: string;
  revision: number;
}

export interface WireAuthMetadata {
  type: string;
  name?: string;
}

export interface WireBindingMetadata {
  name: string;
  revision: number;
  match: WireMatch;
  auth: WireAuthMetadata;
}

/** `GET /credential-vault` response — sanitized: no credential values, ever. */
export interface VaultState {
  revision: number;
  credentials: WireCredentialMetadata[];
  bindings: WireBindingMetadata[];
}

export interface CreateRequest {
  credentials: WireCredential[];
  bindings: WireBinding[];
}

export interface MutationSet<T> {
  add?: T[];
  replace?: T[];
  delete?: string[];
}

export interface MutationRequest {
  expectedRevision?: number;
  credentials?: MutationSet<WireCredential>;
  bindings?: MutationSet<WireBinding>;
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
 * Request/response schema verified against `opensandbox-group/OpenSandbox`'s
 * `components/egress/pkg/credentialvault` Go source directly (not just its docs) — the vault has
 * exactly one resource, created once and then mutated: `POST /credential-vault` creates it
 * (409 if it already exists), `PATCH /credential-vault` adds/replaces/deletes individual
 * credentials and bindings by name, `GET /credential-vault` returns sanitized metadata only
 * (values and full auth config are never echoed back), and `DELETE /credential-vault` removes
 * the whole vault — there is no per-credential DELETE route.
 */
export class VaultClient {
  private static readonly PORT = 18080;

  constructor(private readonly control: ControlClient) {}

  private async request<T>(
    sandboxId: string,
    method: string,
    useServerProxy: boolean | undefined,
    body?: unknown,
  ): Promise<T> {
    const ep = await this.control.getEndpoint(sandboxId, VaultClient.PORT, useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const res = await fetch(`${baseUrl}/credential-vault`, {
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

  /** Creates the sandbox's Credential Vault. Throws `VaultClientError` with `status: 409` if one already exists — see `createOrPatch()`. */
  create(sandboxId: string, req: CreateRequest, useServerProxy?: boolean): Promise<VaultState> {
    return this.request(sandboxId, "POST", useServerProxy, req);
  }

  /** Adds/replaces/deletes individual credentials and bindings on an existing vault. */
  patch(sandboxId: string, req: MutationRequest, useServerProxy?: boolean): Promise<VaultState> {
    return this.request(sandboxId, "PATCH", useServerProxy, req);
  }

  /** Sanitized metadata only — never returns credential values or full auth config. */
  get(sandboxId: string, useServerProxy?: boolean): Promise<VaultState> {
    return this.request(sandboxId, "GET", useServerProxy);
  }

  /** Deletes the *entire* vault (all credentials and bindings) — there is no per-credential delete route. */
  remove(sandboxId: string, useServerProxy?: boolean): Promise<void> {
    return this.request(sandboxId, "DELETE", useServerProxy);
  }

  /**
   * Upserts one credential+binding pair: creates the vault if this is the sandbox's first
   * credential, otherwise patches it in (`replace` if a credential of this name already exists,
   * `add` if it doesn't — an extra `get()` round-trip to tell those apart, since the wire API
   * has no single "upsert" mutation).
   *
   * Retries the initial `create()` briefly on 500/502/412: right after a sandbox (or fork) is
   * created, the egress sidecar's TCP listener can accept a connection a moment before its
   * request-handling — auth-token check, mitmproxy/nftables readiness gate — is fully wired up,
   * which surfaces as a generic proxy 500 (or the sidecar's own 412 "not ready") rather than a
   * clean connection-refused. `set()` on an already-warm sandbox (the common case) succeeds on
   * the first try; this only pays the retry cost right after creation.
   */
  async createOrPatch(
    sandboxId: string,
    credential: WireCredential,
    binding: WireBinding,
    useServerProxy?: boolean,
  ): Promise<VaultState> {
    const delaysMs = [0, 300, 600, 1200, 2400];
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt] > 0) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      try {
        return await this.create(
          sandboxId,
          { credentials: [credential], bindings: [binding] },
          useServerProxy,
        );
      } catch (err) {
        const retryable =
          err instanceof VaultClientError &&
          (err.status === 500 || err.status === 502 || err.status === 412);
        const isLastAttempt = attempt === delaysMs.length - 1;
        if (!retryable || isLastAttempt) {
          if (!(err instanceof VaultClientError) || err.status !== 409) throw err;
          break; // 409: vault already exists — fall through to the patch path below.
        }
      }
    }
    const state = await this.get(sandboxId, useServerProxy);
    const exists = state.credentials.some((c) => c.name === credential.name);
    return this.patch(
      sandboxId,
      exists
        ? { credentials: { replace: [credential] }, bindings: { replace: [binding] } }
        : { credentials: { add: [credential] }, bindings: { add: [binding] } },
      useServerProxy,
    );
  }
}
