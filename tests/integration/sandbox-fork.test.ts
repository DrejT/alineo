import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("sb.fork() branches a running sandbox into independent parallel forks", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "python:3.11-slim",
    resources: { cpu: "1", memory: "512Mi" },
    name: "sandbox-fork-test",
  });

  let forkA: Awaited<ReturnType<typeof sb.fork>> | undefined;
  let forkB: Awaited<ReturnType<typeof sb.fork>> | undefined;

  try {
    const { stdout: installOut } = await sb.exec("pip install -q numpy && echo 'numpy ready'");
    expect(installOut).toContain("numpy ready");

    [forkA, forkB] = await Promise.all([sb.fork("track-a"), sb.fork("track-b")]);
    expect(forkA.sandboxId).not.toBe(sb.sandboxId);
    expect(forkB.sandboxId).not.toBe(sb.sandboxId);
    expect(forkA.sandboxId).not.toBe(forkB.sandboxId);

    // Both forks inherit numpy without reinstalling it — run different workloads
    // in parallel from the same base state.
    const [resultA, resultB] = await Promise.all([
      forkA
        .writeFile("/tmp/run.py", "import numpy as np\nprint(np.arange(5).sum())")
        .then(() => forkA!.exec("python3 /tmp/run.py")),
      forkB
        .writeFile("/tmp/run.py", "import numpy as np\nprint(np.arange(5).prod())")
        .then(() => forkB!.exec("python3 /tmp/run.py")),
    ]);
    expect(resultA.stdout.trim()).toBe("10");
    expect(resultB.stdout.trim()).toBe("0"); // arange(5) includes 0, product is 0

    const checkpoints = await sb.listCheckpoints();
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints.some((c) => c.tag === "track-a")).toBe(true);
    expect(checkpoints.some((c) => c.tag === "track-b")).toBe(true);
  } finally {
    await Promise.all([forkA?.close(), forkB?.close(), sb.close()]);
  }
}, 90_000);
