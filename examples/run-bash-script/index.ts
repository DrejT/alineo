import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const script = `
#!/bin/bash
set -euo pipefail

echo "=== system info ==="
uname -a
echo ""

echo "=== disk usage ==="
df -h /
echo ""

echo "=== writing a file and reading it back ==="
echo "hello from alineo" > /tmp/alineo-test.txt
cat /tmp/alineo-test.txt
echo ""

echo "=== done ==="
`.trim();

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
  name: "bash-script",
});

console.log(`SandboxHandle ID: ${sb.sandboxId}\n`);

try {
  await sb.exec(script, { shell: "/bin/bash" }).pipe(process.stdout);
} finally {
  await sb.close();
}
