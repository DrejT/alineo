import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("exec output is captured and sandbox closes cleanly", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "512Mi" },
    name: "hello-world-test",
  });

  try {
    const { stdout, exitCode } = await sb.exec('echo "hello world"');
    expect(stdout.trim()).toBe("hello world");
    expect(exitCode).toBe(0);
  } finally {
    await sb.close();
  }
}, 60_000);
