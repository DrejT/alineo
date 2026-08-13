/**
 * Demonstrates readFile() — reading a file from the sandbox.
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sb = await client.sandbox({
  image: "node:20-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "read-file-demo",
});

console.log(`Sandbox ID: ${sb.sandboxId}`);

try {
  await sb.exec("node -e \"require('fs').writeFileSync('/tmp/version.txt', process.version)\"");
  const version = await sb.readFile("/tmp/version.txt");
  await sb.exec(`echo "Node version from file: ${version}"`).pipe(process.stdout);

  await sb.writeFile("/tmp/report.json", JSON.stringify({ capturedAt: new Date().toISOString() }));
  const report = await sb.readFile("/tmp/report.json");

  console.log("\n--- captured state ---");
  console.log("version:", version.trim());
  console.log("report:", report);
} finally {
  await sb.close();
}
