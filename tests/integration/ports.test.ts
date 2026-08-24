import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("sb.proxy() exposes an HTTP server inside the sandbox to the host", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "node:22",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "ports-test",
  });

  try {
    await sb.writeFile(
      "/server.js",
      `
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "hello from sandbox", path: req.url }));
  })
  .listen(3000, () => process.stderr.write("listening on 3000\\n"));
`,
    );

    await sb.exec("node /server.js &");
    await sb.exec("sleep 1");

    const { url, headers } = await sb.proxy(3000);
    expect(url).toBeTruthy();

    const res = await fetch(`${url}/ping`, { headers });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { message: string; path: string };
    expect(body.message).toBe("hello from sandbox");
    expect(body.path).toBe("/ping");
  } finally {
    await sb.close();
  }
}, 60_000);
