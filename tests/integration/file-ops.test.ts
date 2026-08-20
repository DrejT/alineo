import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("file ops: create, write, search, read, patch, move, transfer, list, delete", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "file-ops-test",
  });

  try {
    await sb.createDirectory("/workspace/src");
    await sb.createDirectory("/workspace/dist");

    await sb.writeFile("/workspace/src/index.ts", 'export const VERSION = "0.0.0";\n');
    await sb.writeFile("/workspace/src/util.ts", 'export const helper = () => "ok";\n');

    const info = await sb.getFileInfo("/workspace/src/index.ts");
    expect(info.type).toBe("file");
    expect(info.size).toBeGreaterThan(0);

    const tsFiles = await sb.searchFiles("*.ts", "/workspace/src");
    expect(tsFiles.some((f: string) => f.endsWith("index.ts"))).toBe(true);
    expect(tsFiles.some((f: string) => f.endsWith("util.ts"))).toBe(true);

    const indexSrc = await sb.readFile("/workspace/src/index.ts");
    expect(indexSrc).toContain("0.0.0");

    await sb.replaceInFiles([{ path: "/workspace/src/index.ts", old: "0.0.0", new: "1.2.3" }]);
    const afterPatch = await sb.readFile("/workspace/src/index.ts");
    expect(afterPatch).toContain("1.2.3");

    await sb.moveFile("/workspace/src/index.ts", "/workspace/dist/index.ts");
    const distEntries = await sb.listDirectory("/workspace/dist");
    expect(distEntries.some((e: { path: string }) => e.path.endsWith("index.ts"))).toBe(true);

    const sb2 = await client.sandbox({
      image: "ubuntu:22.04",
      resources: { cpu: "500m", memory: "256Mi" },
      name: "file-ops-transfer-target",
    });
    try {
      await sb.transfer("/workspace/dist/index.ts", sb2);
      const received = await sb2.readFile("/workspace/dist/index.ts");
      expect(received).toContain("1.2.3");
    } finally {
      await sb2.close();
    }

    await sb.deleteFile("/workspace/src/util.ts");
    await sb.deleteDirectory("/workspace/src");
    const remaining = await sb.listDirectory("/workspace");
    expect(remaining.some((e: { path: string }) => e.path.endsWith("/src"))).toBe(false);
  } finally {
    await sb.close();
  }
}, 60_000);
