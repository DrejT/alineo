/**
 * Demonstrates the SandboxHandle file operations API:
 * writeFile, readFile, moveFile, deleteFile, searchFiles, listDirectory,
 * createDirectory, deleteDirectory, getFileInfo, replaceInFiles, transfer
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "file-ops-demo",
});

console.log(`SandboxHandle ID: ${sb.sandboxId}\n`);

try {
  // Create directories directly (no exec needed)
  await sb.createDirectory("/workspace/src");
  await sb.createDirectory("/workspace/dist");

  // Write files
  await sb.writeFile("/workspace/src/index.ts", 'export const VERSION = "0.0.0";\n');
  await sb.writeFile("/workspace/src/util.ts", 'export const helper = () => "ok";\n');
  await sb.writeFile(
    "/workspace/src/config.json",
    JSON.stringify({ host: "localhost", port: 3000 }, null, 2),
  );

  // File metadata
  const info = await sb.getFileInfo("/workspace/src/index.ts");
  console.log("File info:", { size: info.size, type: info.type, mode: info.mode });

  // Search for files
  const tsFiles = await sb.searchFiles("*.ts", "/workspace/src");
  console.log("TS files:", tsFiles);

  // Read a file
  const indexSrc = await sb.readFile("/workspace/src/index.ts");
  console.log("Before patch:", indexSrc.trim());

  // In-place patch — no exec/sed needed
  await sb.replaceInFiles([
    { path: "/workspace/src/index.ts", old: "0.0.0", new: "1.2.3" },
    { path: "/workspace/src/config.json", old: "localhost", new: "0.0.0.0" },
  ]);
  const afterPatch = await sb.readFile("/workspace/src/index.ts");
  console.log("After patch:", afterPatch.trim());

  // Move a file
  await sb.moveFile("/workspace/src/index.ts", "/workspace/dist/index.ts");

  // List directory
  const distEntries = await sb.listDirectory("/workspace/dist");
  console.log(
    "Dist entries:",
    distEntries.map((e: { path: string }) => e.path),
  );

  // Transfer a file to a second sandbox
  const sb2 = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "file-ops-target",
  });
  try {
    await sb.transfer("/workspace/dist/index.ts", sb2);
    const received = await sb2.readFile("/workspace/dist/index.ts");
    console.log("Received in sb2:", received.trim());
  } finally {
    await sb2.close();
  }

  // Delete a file and a directory
  await sb.deleteFile("/workspace/src/util.ts");
  await sb.deleteDirectory("/workspace/src");
  const remaining = await sb.listDirectory("/workspace");
  console.log(
    "Remaining:",
    remaining.map((e: { path: string }) => e.path),
  );
} finally {
  await sb.close();
}
