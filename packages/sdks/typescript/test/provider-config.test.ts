import { describe, expect, it } from "vitest";
import { OpenSandboxProvider } from "@alineo-labs/opensandbox";
import { isAlineoError } from "@alineo-labs/errors";
import { KNOWN_PROVIDERS, clientFromConfig, providerFromConfig } from "../src/provider-config";

const base = { serverUrl: "http://127.0.0.1:8080", apiKey: "", useServerProxy: true };

describe("providerFromConfig", () => {
  it("builds the OpenSandbox provider when the config names it", () => {
    const provider = providerFromConfig({ ...base, provider: "opensandbox" });

    expect(provider).toBeInstanceOf(OpenSandboxProvider);
    expect(provider.id).toBe("opensandbox");
  });

  it("builds the OpenSandbox provider when the config names none", () => {
    expect(providerFromConfig(base)).toBeInstanceOf(OpenSandboxProvider);
  });

  it("refuses an unknown provider and names the known ones", () => {
    let thrown: unknown;
    try {
      providerFromConfig({ ...base, provider: "nope" });
    } catch (e) {
      thrown = e;
    }

    expect(isAlineoError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((thrown as Error).message).toBe(
      `Unknown sandbox provider "nope". Known providers: ${KNOWN_PROVIDERS.join(", ")}.`,
    );
  });
});

describe("clientFromConfig", () => {
  it("returns a client that runs on the provider the config names", () => {
    const client = clientFromConfig(
      { ...base, provider: "opensandbox" },
      // The ledger is never touched: nothing is created.
      { adapter: {} as never },
    );

    expect(client.provider.id).toBe("opensandbox");
  });

  it("throws before it builds a client for an unknown provider", () => {
    expect(() => clientFromConfig({ ...base, provider: "nope" }, { adapter: {} as never })).toThrow(
      /Unknown sandbox provider "nope"/,
    );
  });
});
