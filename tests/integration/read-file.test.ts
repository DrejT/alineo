import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("readFile returns content written by exec and by writeFile", async () => {
  const client = new Alineo({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "node:20-slim",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "read-file-test",
  });

  try {
    await sb.exec("node -e \"require('fs').writeFileSync('/tmp/version.txt', process.version)\"");
    const version = await sb.readFile("/tmp/version.txt");
    expect(version.trim()).toMatch(/^v\d+/);

    await sb.writeFile(
      "/tmp/report.json",
      JSON.stringify({ capturedAt: new Date().toISOString() }),
    );
    const report = await sb.readFile("/tmp/report.json");
    expect(() => JSON.parse(report)).not.toThrow();
    expect(report).toContain("capturedAt");
  } finally {
    await sb.close();
  }
}, 60_000);
