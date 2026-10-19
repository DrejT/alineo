import {
  clientFromConfig,
  errorCodeOf,
  isAlineoError,
  isRetryable,
  type Sandbox,
} from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { describe, expect, test } from "bun:test";

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const resources = { cpu: "500m", memory: "256Mi" };

function makeClient(): Sandbox {
  return clientFromConfig(
    {
      serverUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
      apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
      useServerProxy: USE_SERVER_PROXY,
    },
    { adapter: new SQLiteAdapter(":memory:") },
  );
}

describe("error codes", () => {
  test("a failed command is COMMAND_FAILED and not retryable", async () => {
    const client = makeClient();
    const sb = await client.sandbox({
      image: "debian:bookworm-slim",
      resources,
      name: "codes-cmd",
    });
    try {
      const err = await Promise.resolve(sb.exec("exit 42")).catch((e: unknown) => e);
      expect(errorCodeOf(err)).toBe("COMMAND_FAILED");
      expect(isRetryable(err)).toBe(false);
    } finally {
      await sb.close();
    }
  }, 90_000);

  test("a command on a sandbox that was closed is SANDBOX_NOT_FOUND, not a raw Error", async () => {
    const client = makeClient();
    const sb = await client.sandbox({
      image: "debian:bookworm-slim",
      resources,
      name: "codes-closed",
    });
    await sb.exec("echo warm");
    await sb.close();

    const err = await Promise.resolve(sb.exec("echo again")).catch((e: unknown) => e);

    expect(isAlineoError(err)).toBe(true);
    expect(errorCodeOf(err)).toBe("SANDBOX_NOT_FOUND");
  }, 90_000);

  test("a sandbox that is not there is SANDBOX_NOT_FOUND, with a hint", async () => {
    const err = await makeClient()
      .connect("00000000-0000-0000-0000-000000000000", "missing")
      .catch((e: unknown) => e);

    expect(errorCodeOf(err)).toBe("SANDBOX_NOT_FOUND");
    expect(isRetryable(err)).toBe(false);
    expect(isAlineoError(err) && typeof err.hint === "string" && err.hint.length > 0).toBe(true);
  }, 30_000);

  test("an image that cannot be pulled fails with an alineo error and does not hang", async () => {
    const started = Date.now();
    const err = await makeClient()
      .sandbox({ image: "registry.invalid/nope:1", resources, name: "codes-image" })
      .catch((e: unknown) => e);

    expect(isAlineoError(err)).toBe(true);
    expect(errorCodeOf(err)).toBeDefined();
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
