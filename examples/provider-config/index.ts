/**
 * Demonstrates choosing the sandbox provider from config:
 *   1. providerFromConfig()  — build the provider a config names, and read what it can do
 *   2. an unknown provider   — refused with INVALID_ARGUMENT, naming the known ones
 *   3. clientFromConfig()    — a client on that provider; the ledger records which one
 *   4. a capability the provider lacks — refused before any container exists
 *
 * Needs: OpenSandbox server running (bunx alineo-cli init).
 */
import {
  clientFromConfig,
  errorCodeOf,
  LedgerEvent,
  providerFromConfig,
  Sandbox,
  type ProviderConfig,
} from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

// The part of alineo.config.json that picks a provider. `provider` defaults to "opensandbox".
const config: ProviderConfig = {
  provider: "opensandbox",
  serverUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
};

console.log("── 1. providerFromConfig() ──────────────────────────────────");
const provider = providerFromConfig(config);
console.log(`provider id: ${provider.id}`);
console.log(`capabilities: ${JSON.stringify(provider.descriptor.capabilities)}`);

console.log("\n── 2. an unknown provider ───────────────────────────────────");
try {
  providerFromConfig({ ...config, provider: "nope" });
} catch (e) {
  console.log(`${errorCodeOf(e)}: ${(e as Error).message}`);
}

console.log("\n── 3. clientFromConfig() ────────────────────────────────────");
const adapter = new SQLiteAdapter("./ledger.db");
const client = clientFromConfig(config, { adapter });
console.log(`client runs on: ${client.provider.id}`);

const sb = await client.sandbox({
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "provider-config",
});
try {
  const { stdout } = await sb.exec("echo hello from the configured provider");
  console.log(stdout.trim());
  const created = (await adapter.readAll("provider-config", sb.sandboxId)).find(
    (entry) => entry.event === LedgerEvent.SandboxCreated,
  );
  console.log(
    `ledger says the sandbox is owned by: ${(created?.payload as { provider?: string }).provider}`,
  );
} finally {
  await sb.close();
}

console.log("\n── 4. a provider that cannot enforce egress ─────────────────");
// The same provider, declaring it cannot do egress. Nothing else about it changes.
const noEgress = Object.create(provider, {
  descriptor: {
    value: {
      ...provider.descriptor,
      capabilities: { ...provider.descriptor.capabilities, egress: false },
    },
  },
}) as typeof provider;
const restricted = new Sandbox({ provider: noEgress, adapter });
try {
  await restricted.sandbox({
    image: "debian:bookworm-slim",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "provider-config-egress",
    networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "example.com" }] },
  });
  console.log("unexpected: the sandbox was created");
} catch (e) {
  console.log(`${errorCodeOf(e)}: ${(e as Error).message}`);
}
