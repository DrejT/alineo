import { Sandbox, CommandError } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect, describe } from "bun:test";

// `useServerProxy` defaults on: an `alineo init` (Docker) server hands out
// container-internal endpoints that aren't reachable from the host. Set
// `OPEN_SANDBOX_SERVER_PROXY=false` for a bare `uvx opensandbox-server`, where the
// direct endpoints work.
const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";

function makeClient(): Sandbox {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
}

describe("error handling", () => {
  test("non-strict exec: exitCode reflects failure without throwing", async () => {
    const client = makeClient();
    const sb = await client.sandbox({
      image: "debian:bookworm-slim",
      resources: { cpu: "500m", memory: "256Mi" },
      name: "error-handling-a-test",
    });

    try {
      const { exitCode } = await sb.exec("exit 1", { strict: false });
      expect(exitCode).toBe(1);
    } finally {
      await sb.close();
    }
  }, 60_000);

  test("strict exec (default): CommandError thrown with correct exit code", async () => {
    const client = makeClient();
    const sb = await client.sandbox({
      image: "debian:bookworm-slim",
      resources: { cpu: "500m", memory: "256Mi" },
      name: "error-handling-b-test",
    });

    try {
      await sb.exec("echo 'about to fail'");

      let caughtError: CommandError | undefined;
      try {
        await sb.exec("exit 42");
      } catch (e) {
        if (e instanceof CommandError) caughtError = e;
        else throw e;
      }

      expect(caughtError).toBeInstanceOf(CommandError);
      expect(caughtError?.exitCode).toBe(42);
    } finally {
      await sb.close();
    }
  }, 60_000);
});
