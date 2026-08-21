/**
 * Demonstrates sandbox HTTP port proxying:
 * start an HTTP server inside a sandbox, get a proxy URL via sb.proxy(),
 * and send requests to it from the host process.
 * Also shows sandbox-to-sandbox communication by injecting the proxy URL as an env var.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

// SandboxHandle A: runs an HTTP server on port 3000
const sbA = await client.sandbox({
  image: "node:22",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "ports-server",
});

console.log(`Server sandbox: ${sbA.sandboxId}\n`);

try {
  // Write a simple HTTP server
  await sbA.writeFile(
    "/server.js",
    `
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "hello from sandbox", path: req.url, from: "sbA" }));
  })
  .listen(3000, () => process.stderr.write("listening on 3000\\n"));
`,
  );

  // Start server in background, then wait for it to bind
  await sbA.exec("node /server.js &");
  await sbA.exec("sleep 1");

  // Get the proxy URL for port 3000
  const { url, headers } = await sbA.proxy(3000);
  console.log(`Proxy URL:  ${url}`);
  console.log(`Headers:    ${JSON.stringify(headers)}\n`);

  // Hit it from the host process
  const res = await fetch(`${url}/ping`, { headers });
  const body = await res.json();
  console.log("Host → sbA:", body);

  // Also works for any path
  const res2 = await fetch(`${url}/status`, { headers });
  console.log("Host → sbA /status:", await res2.json());

  // Note: in local Docker bridge mode, the proxy URL (127.0.0.1) is the host's loopback
  // and is NOT reachable from inside another sandbox container.
  // SandboxHandle-to-sandbox HTTP calls via proxy work in cloud/routable ingress modes only.
} finally {
  await sbA.close();
}
