import { OpenSandboxProvider } from "@alineo-labs/opensandbox";
import type { SandboxProvider } from "@alineo-labs/provider";
import { Sandbox } from "./client";
import { SandboxClientError } from "./types";
import type { SandboxClientOptions } from "./types";

/**
 * The part of `alineo.config.json` that picks a provider and says where it is. Structural, so
 * the SDK needs no dependency on the package that loads the file.
 */
export interface ProviderConfig {
  /** Which provider. Absent means `"opensandbox"`. */
  provider?: string;
  /** OpenSandbox server URL. */
  serverUrl: string;
  apiKey?: string;
  useServerProxy?: boolean;
}

/** The provider ids `providerFromConfig` can build. */
export const KNOWN_PROVIDERS = ["opensandbox"] as const;

/**
 * Build the provider a config names.
 *
 * An id this build does not know is refused here, naming the ids it does know. Guessing
 * OpenSandbox instead would run someone's agents on the wrong substrate without a word.
 */
export function providerFromConfig(config: ProviderConfig): SandboxProvider {
  const id = config.provider ?? "opensandbox";
  switch (id) {
    case "opensandbox":
      return new OpenSandboxProvider({
        baseUrl: config.serverUrl,
        apiKey: config.apiKey ?? "",
        useServerProxy: config.useServerProxy ?? false,
      });
    default:
      throw new SandboxClientError(
        `Unknown sandbox provider "${id}". Known providers: ${KNOWN_PROVIDERS.join(", ")}.`,
        400,
        "INVALID_ARGUMENT",
      );
  }
}

/**
 * A {@link Sandbox} client for the provider a config names. Every CLI command and the agent
 * runtime build their client through this, so the provider is chosen in one place.
 */
export function clientFromConfig(
  config: ProviderConfig,
  options: Omit<SandboxClientOptions, "provider" | "baseUrl" | "apiKey" | "useServerProxy">,
): Sandbox {
  return new Sandbox({
    ...options,
    provider: providerFromConfig(config),
    // The client reads this for its credential broker, which is built over the provider.
    useServerProxy: config.useServerProxy ?? false,
  });
}
