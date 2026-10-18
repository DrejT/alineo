import {
  clientFromConfig,
  errorCodeOf,
  LedgerEvent,
  providerFromConfig,
  Sandbox,
  type ProviderConfig,
} from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { describe, expect, test } from "bun:test";

const config: ProviderConfig = {
  provider: "opensandbox",
  serverUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  useServerProxy: process.env.OPEN_SANDBOX_SERVER_PROXY !== "false",
};
const resources = { cpu: "500m", memory: "256Mi" };

describe("the provider comes from config", () => {
  test("providerFromConfig builds opensandbox and reports what it can do", () => {
    const provider = providerFromConfig(config);
    expect(provider.id).toBe("opensandbox");
    expect(provider.descriptor.capabilities.snapshot).toBeTruthy();
    expect(provider.descriptor.capabilities.pause).toBe(true);
  });

  test("a config with no provider key runs on opensandbox", () => {
    const { provider: _omitted, ...withoutProvider } = config;
    expect(providerFromConfig(withoutProvider).id).toBe("opensandbox");
  });

  test("an unknown provider is INVALID_ARGUMENT and names the known ones", () => {
    let thrown: unknown;
    try {
      providerFromConfig({ ...config, provider: "nope" });
    } catch (e) {
      thrown = e;
    }
    expect(errorCodeOf(thrown)).toBe("INVALID_ARGUMENT");
    expect((thrown as Error).message).toContain("opensandbox");
  });

  test("the ledger records which provider owns the sandbox", async () => {
    const adapter = new SQLiteAdapter(":memory:");
    const client = clientFromConfig(config, { adapter });
    const sb = await client.sandbox({
      image: "debian:bookworm-slim",
      resources,
      name: "provider-config-test",
    });
    try {
      const { stdout } = await sb.exec("echo hi");
      expect(stdout.trim()).toBe("hi");
      const created = (await adapter.readAll("provider-config-test", sb.sandboxId)).find(
        (entry) => entry.event === LedgerEvent.SandboxCreated,
      );
      expect((created?.payload as { provider?: string }).provider).toBe("opensandbox");
    } finally {
      await sb.close();
    }
  }, 90_000);

  test("a provider that lacks a capability is refused before any container exists", async () => {
    const real = providerFromConfig(config);
    const noEgress = Object.create(real, {
      descriptor: {
        value: {
          ...real.descriptor,
          capabilities: { ...real.descriptor.capabilities, egress: false },
        },
      },
    }) as typeof real;
    const client = new Sandbox({ provider: noEgress, adapter: new SQLiteAdapter(":memory:") });

    const err = await client
      .sandbox({
        image: "debian:bookworm-slim",
        resources,
        name: "provider-config-egress-test",
        networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "example.com" }] },
      })
      .catch((e: unknown) => e);

    expect(errorCodeOf(err)).toBe("CAPABILITY_UNSUPPORTED");
  }, 30_000);
});
