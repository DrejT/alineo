import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("multi-line bash script executes and produces expected output", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const script = `
#!/bin/bash
set -euo pipefail
echo "=== system info ==="
uname -a
echo "=== writing a file and reading it back ==="
echo "hello from alineo" > /tmp/alineo-test.txt
cat /tmp/alineo-test.txt
echo "=== done ==="
  `.trim();

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "bash-script-test",
  });

  try {
    const { stdout, exitCode } = await sb.exec(script, { shell: "/bin/bash" });
    expect(stdout).toContain("=== system info ===");
    expect(stdout).toContain("hello from alineo");
    expect(stdout).toContain("=== done ===");
    expect(exitCode).toBe(0);
  } finally {
    await sb.close();
  }
}, 60_000);
