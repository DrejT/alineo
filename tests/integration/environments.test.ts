import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("environment builds once, caches a snapshot, and restores from it", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const env = client.environment("environments-test", {
    image: "python:3.11-slim",
    resources: { cpu: "500m", memory: "512Mi" },
    setup: async (sb) => {
      await sb.exec("pip install --quiet numpy");
    },
  });

  expect(await env.info()).toBeNull();

  const sb = await env.sandbox();
  try {
    const { stdout } = await sb.exec('python3 -c "import numpy; print(numpy.__version__)"');
    expect(stdout.trim()).toMatch(/^\d+\.\d+/);
  } finally {
    await sb.close();
  }

  const record = await env.info();
  expect(record).not.toBeNull();
  expect(record?.snapshotId).toBeTruthy();

  // Second sandbox() restores from the now-cached snapshot rather than rerunning setup.
  const sb2 = await env.sandbox();
  try {
    const { stdout } = await sb2.exec('python3 -c "import numpy; print(numpy.__version__)"');
    expect(stdout.trim()).toMatch(/^\d+\.\d+/);
  } finally {
    await sb2.close();
  }
}, 120_000);
