import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

// `useServerProxy` defaults on: an `alineo init` (Docker) server hands out
// container-internal endpoints that aren't reachable from the host. Set
// `OPEN_SANDBOX_SERVER_PROXY=false` for a bare `uvx opensandbox-server`, where the
// direct endpoints work.
const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";

test("readFile returns content written by exec and by writeFile", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
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
