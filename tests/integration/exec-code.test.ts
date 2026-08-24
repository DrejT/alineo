import { Sandbox, CodeLanguage } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("isolated and stateful Python execution via createCodeContext/execCode", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "opensandbox/code-interpreter",
    entrypoint: ["/opt/code-interpreter/code-interpreter.sh"],
    resources: { cpu: "500m", memory: "512Mi" },
    name: "exec-code-test",
  });

  try {
    // Isolated — a fresh context; nothing shared with the stateful pair below.
    const isolatedCtx = await sb.createCodeContext(CodeLanguage.Python);
    const { stdout: piOut } = await sb.execCode(
      ["import sys, math", 'print(f"pi = {math.pi:.6f}")'].join("\n"),
      { context: isolatedCtx },
    );
    expect(piOut).toContain("pi = 3.141593");

    // Stateful — two calls sharing one context; the second sees the first's variables.
    const ctx = await sb.createCodeContext(CodeLanguage.Python);
    await sb.execCode("data = [2**i for i in range(8)]", { context: ctx });
    const { stdout: sumOut } = await sb.execCode(
      ["total = sum(data)", 'print(f"sum = {total}")', 'print(f"max = {max(data)}")'].join("\n"),
      { context: ctx },
    );
    expect(sumOut).toContain("sum = 255");
    expect(sumOut).toContain("max = 128");
  } finally {
    await sb.close();
  }
}, 60_000);
