import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("checkpoint + resume: replayed execs return cached output, new execs run live", async () => {
  const client = new Alineo({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "python:3.11-slim",
    resources: { cpu: "1", memory: "512Mi" },
    name: "snapshot-replay-test",
  });

  const originalSandboxId = sb.sandboxId;
  let checkpointId: string;

  try {
    const { stdout: installOut } = await sb.exec("pip install -q requests && echo installed");
    expect(installOut).toContain("installed");

    checkpointId = await sb.checkpoint("after-install");
    expect(checkpointId).toBeTruthy();

    await sb.writeFile("/tmp/script.py", 'print("original run")');
    const { stdout: originalOut } = await sb.exec("python3 /tmp/script.py");
    expect(originalOut).toContain("original run");
  } finally {
    await sb.close();
  }

  const resumed = await client.resume(originalSandboxId);
  try {
    // Same call site/order as the install exec above -> same seq -> replayed from
    // the ledger cache instead of actually re-running the pip install.
    const { stdout: replayedOut } = await resumed.exec("pip install -q requests && echo installed");
    expect(replayedOut).toContain("installed");

    // A genuinely new exec (past the checkpointed sequence) runs live against the
    // restored container.
    await resumed.writeFile("/tmp/script.py", 'print("resumed run")');
    const { stdout: resumedOut } = await resumed.exec("python3 /tmp/script.py");
    expect(resumedOut).toContain("resumed run");
  } finally {
    await resumed.close();
  }
}, 60_000);
