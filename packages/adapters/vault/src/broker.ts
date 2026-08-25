import type { CredentialBroker, CredentialBinding } from "@alineo-labs/core";
import type { ControlClient } from "@alineo-labs/opensandbox";
import { VaultClient, VaultClientError } from "./vault-client";

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
    try {
      await this.vault.create(
        sandboxId,
        {
          name,
          value,
          host: binding.host,
          pathPrefix: binding.pathPrefix,
          injection: binding.injection,
        },
        this.useServerProxy,
      );
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

  async patch(
    sandboxId: string,
    name: string,
    changes: Partial<{ value: string; binding: CredentialBinding }>,
  ): Promise<void> {
    await this.vault.patch(
      sandboxId,
      name,
      {
        ...(changes.value !== undefined ? { value: changes.value } : {}),
        ...(changes.binding
          ? {
              host: changes.binding.host,
              pathPrefix: changes.binding.pathPrefix,
              injection: changes.binding.injection,
            }
          : {}),
      },
      this.useServerProxy,
    );
  }

  async remove(sandboxId: string, name: string): Promise<void> {
    await this.vault.remove(sandboxId, name, this.useServerProxy);
  }

  async listBindings(
    sandboxId: string,
  ): Promise<Array<{ name: string; binding: CredentialBinding }>> {
    const entries = await this.vault.list(sandboxId, this.useServerProxy);
    return entries.map((e) => ({
      name: e.name,
      binding: { host: e.host, pathPrefix: e.pathPrefix, injection: e.injection },
    }));
  }
}
