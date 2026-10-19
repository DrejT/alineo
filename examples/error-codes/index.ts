/**
 * Demonstrates stable error codes. Every failure carries a `code` you can branch on,
 * instead of matching on message text:
 *   1. a command that fails        — COMMAND_FAILED, not retryable
 *   2. a sandbox that is not there — SANDBOX_NOT_FOUND, with a hint that says what to do next
 *   3. an image that cannot be pulled — a provider code, and whether a retry may help
 *   4. branching on the code, not the message
 *
 * Needs: OpenSandbox server running (bunx alineo-cli init).
 */
import {
  clientFromConfig,
  errorCodeOf,
  isAlineoError,
  isRetryable,
  type ProviderConfig,
} from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const config: ProviderConfig = {
  serverUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
};
const client = clientFromConfig(config, { adapter: new SQLiteAdapter("./ledger.db") });
const resources = { cpu: "500m", memory: "256Mi" };

function report(label: string, err: unknown): void {
  const hint = isAlineoError(err) ? err.hint : undefined;
  console.log(`${label}`);
  console.log(`  code:      ${errorCodeOf(err)}`);
  console.log(`  retryable: ${isRetryable(err)}`);
  console.log(`  message:   ${(err as Error).message.slice(0, 100)}`);
  if (hint) console.log(`  hint:      ${hint}`);
}

console.log("── 1. a command that fails ──────────────────────────────────");
const sb = await client.sandbox({ image: "debian:bookworm-slim", resources, name: "error-codes" });
try {
  await sb.exec("exit 42");
} catch (e) {
  report("sb.exec('exit 42')", e);
} finally {
  await sb.close();
}

console.log("\n── 2. a sandbox that is not there ───────────────────────────");
try {
  await client.connect("00000000-0000-0000-0000-000000000000", "missing");
} catch (e) {
  report("client.connect(<unknown id>)", e);
}

console.log("\n── 3. an image that cannot be pulled ────────────────────────");
try {
  await client.sandbox({ image: "registry.invalid/nope:1", resources, name: "bad-image" });
} catch (e) {
  report("client.sandbox({ image: 'registry.invalid/nope:1' })", e);
}

console.log("\n── 4. branch on the code, not the message ───────────────────");
try {
  await client.connect("00000000-0000-0000-0000-000000000000", "missing");
} catch (e) {
  switch (errorCodeOf(e)) {
    case "SANDBOX_NOT_FOUND":
      console.log("the sandbox is gone: start a new one");
      break;
    default:
      throw e;
  }
}
