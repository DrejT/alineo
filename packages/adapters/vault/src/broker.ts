import type { CredentialBroker, CredentialBinding } from "@alineo-labs/core";
import type { ControlClient } from "@alineo-labs/opensandbox";
import {
  VaultClient,
  VaultClientError,
  type WireAuth,
  type WireBinding,
  type WireCredential,
} from "./vault-client";

/**
 * Thrown when a `CredentialBinding.injection` has no equivalent in the sidecar's real `Auth`
 * model. Only header injection (`{ type: "header" }`) maps onto it today — it supports
 * `bearer`/`basic`/`apiKey`/`customHeaders` header injection and placeholder `substitutions`
 * (for path/query/body), but not an arbitrary named query param or path segment the way this
 * package's `{ type: "query" }`/`{ type: "path" }` binding shapes imply. Wire those up to
 * `substitutions` (which needs a literal placeholder string in the request, a different model
 * from "inject a named param") before lifting this restriction.
 */
export class UnsupportedInjectionError extends Error {
  constructor(injectionType: string) {
    super(
      `Credential injection type "${injectionType}" is not yet supported by ` +
        `@alineo-labs/vault — only { type: "header" } maps onto the egress sidecar's real ` +
        `Credential Vault API today.`,
    );
    this.name = "UnsupportedInjectionError";
  }
}

function toWireAuth(name: string, injection: CredentialBinding["injection"]): WireAuth {
  if (injection.type !== "header") throw new UnsupportedInjectionError(injection.type);
  return { type: "apiKey", name: injection.name, credential: name };
}

function toWireBinding(name: string, binding: CredentialBinding): WireBinding {
  return {
    name,
    match: {
      hosts: [binding.host],
      ...(binding.pathPrefix ? { paths: [`${binding.pathPrefix}*`] } : {}),
    },
    auth: toWireAuth(name, binding.injection),
  };
}

function fromWireBindingMetadata(meta: {
  match: { hosts: string[]; paths?: string[] };
  auth: { type: string; name?: string };
}): CredentialBinding {
  if (meta.auth.type !== "apiKey" || !meta.auth.name) {
    // Only bindings this package itself created (always `apiKey`) round-trip cleanly.
    throw new UnsupportedInjectionError(meta.auth.type);
  }
  const path = meta.match.paths?.[0];
  return {
    host: meta.match.hosts[0] ?? "",
    ...(path && path !== "/*" ? { pathPrefix: path.replace(/\*$/, "") } : {}),
    injection: { type: "header", name: meta.auth.name },
  };
}

/**
 * Default `CredentialBroker` implementation, backed by OpenSandbox's own Credential Vault.
 *
 * `Sandbox` (from `@alineo-labs/sandbox`) constructs one of these automatically, wired to its
 * own internal `ControlClient`, when `SandboxClientOptions.credentialBroker` is omitted — most
 * callers never need to construct this directly.
 *
 * @example
 * ```ts
 * const sb = await client.sandbox({
 *   image: "node:22",
 *   resources: { cpu: "500m", memory: "512Mi" },
 *   networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "api.github.com" }] },
 *   credentialProxy: true,
 * });
 * await sb.credentials.set("github", process.env.GH_TOKEN!, {
 *   host: "api.github.com",
 *   injection: { type: "header", name: "Authorization" },
 * });
 * ```
 */
export class OpenSandboxCredentialBroker implements CredentialBroker {
  private readonly vault: VaultClient;

  constructor(
    control: ControlClient,
    private readonly useServerProxy?: boolean,
  ) {
    this.vault = new VaultClient(control);
  }

  async set(
    sandboxId: string,
    name: string,
    value: string,
    binding: CredentialBinding,
  ): Promise<void> {
    const credential: WireCredential = { name, source: { type: "inline", value } };
    const wireBinding = toWireBinding(name, binding);
    try {
      await this.vault.createOrPatch(sandboxId, credential, wireBinding, this.useServerProxy);
    } catch (err) {
      if (err instanceof VaultClientError && err.status === 404) {
        throw new VaultClientError(
          `Sandbox ${sandboxId} has no Credential Vault — was it created with credentialProxy: true?`,
          404,
        );
      }
      throw err;
    }
  }

  /**
   * Both `changes.value` and `changes.binding` are required — the vault's `GET` response never
   * echoes credential values back (by design, for security), so there is no way to preserve
   * "the current value" while only replacing the binding, or vice versa. Pass both.
   */
  async patch(
    sandboxId: string,
    name: string,
    changes: Partial<{ value: string; binding: CredentialBinding }>,
  ): Promise<void> {
    if (changes.value === undefined || changes.binding === undefined) {
      throw new Error(
        "OpenSandboxCredentialBroker.patch() requires both `value` and `binding` — the sidecar's " +
          "Credential Vault never echoes values back, so a partial update can't preserve the " +
          "unspecified half.",
      );
    }
    await this.vault.patch(
      sandboxId,
      {
        credentials: { replace: [{ name, source: { type: "inline", value: changes.value } }] },
        bindings: { replace: [toWireBinding(name, changes.binding)] },
      },
      this.useServerProxy,
    );
  }

  async remove(sandboxId: string, name: string): Promise<void> {
    await this.vault.patch(
      sandboxId,
      { credentials: { delete: [name] }, bindings: { delete: [name] } },
      this.useServerProxy,
    );
  }

  async listBindings(
    sandboxId: string,
  ): Promise<Array<{ name: string; binding: CredentialBinding }>> {
    const state = await this.vault.get(sandboxId, this.useServerProxy);
    return state.bindings.map((b) => ({ name: b.name, binding: fromWireBindingMetadata(b) }));
  }
}
