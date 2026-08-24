import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("captured exec stdout is usable in subsequent steps and files", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "node:20-slim",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "capture-test",
  });

  try {
    const { stdout: nodeVersion } = await sb.exec(
      'node -e "process.stdout.write(process.version)"',
    );
    expect(nodeVersion.trim()).toMatch(/^v\d+/);

    await sb.writeFile(
      "/tmp/info.json",
      JSON.stringify({ node: nodeVersion.trim(), capturedAt: new Date().toISOString() }),
    );

    const infoJson = await sb.readFile("/tmp/info.json");
    const parsed = JSON.parse(infoJson);
    expect(parsed.node).toBe(nodeVersion.trim());
  } finally {
    await sb.close();
  }
}, 60_000);
