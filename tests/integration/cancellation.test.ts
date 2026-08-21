import { Sandbox, CommandError } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect, describe } from "bun:test";

function makeClient(): Sandbox {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });
}

const image = "ubuntu:22.04";
const resources = { cpu: "500m", memory: "256Mi" };

describe("cancellation and error patterns", () => {
  test("try/finally always closes the sandbox, even without an error", async () => {
    const client = makeClient();
    const sb = await client.sandbox({ image, resources, name: "cancellation-a-test" });
    try {
      const { stdout } = await sb.exec("echo done");
      expect(stdout.trim()).toBe("done");
    } finally {
      await sb.close();
    }
    // Closing twice is a documented no-op, not an error.
    await expect(sb.close()).resolves.toBeUndefined();
  }, 60_000);

  test("bash-level `timeout` command bounds a long-running exec", async () => {
    const client = makeClient();
    const sb = await client.sandbox({ image, resources, name: "cancellation-b-test" });
    try {
      const { stdout, exitCode } = await sb.exec("timeout 1 sleep 30 || echo 'timed out'", {
        strict: false,
      });
      expect(stdout.trim()).toBe("timed out");
      expect(exitCode).toBe(0); // `|| echo` makes the overall command succeed
    } finally {
      await sb.close();
    }
  }, 60_000);

  test("CommandError is thrown from a non-zero exit and carries the exit code", async () => {
    const client = makeClient();
    const sb = await client.sandbox({ image, resources, name: "cancellation-c-test" });
    try {
      await sb.exec("echo 'step 1'");
      let caught: CommandError | undefined;
      try {
        await sb.exec("exit 1");
      } catch (e) {
        if (e instanceof CommandError) caught = e;
        else throw e;
      }
      expect(caught).toBeInstanceOf(CommandError);
      expect(caught?.exitCode).toBe(1);
    } finally {
      await sb.close();
    }
  }, 60_000);
});
