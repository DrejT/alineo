/**
 * Recipe: install dependencies once, then fork into N independent sandboxes
 * that each run a shard of the test suite in parallel — cutting wall-clock
 * time roughly by the number of shards, without repeating the install.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const TEST_FILES: Record<string, string> = {
  "test_shard_a.py": [
    "def test_one():",
    "    assert 1 + 1 == 2",
    "",
    "def test_two():",
    "    assert sorted([3, 1, 2]) == [1, 2, 3]",
    "",
  ].join("\n"),
  "test_shard_b.py": [
    "def test_three():",
    "    assert 'ab'.upper() == 'AB'",
    "",
    "def test_four():",
    "    assert len(range(10)) == 10",
    "",
  ].join("\n"),
  "test_shard_c.py": [
    "def test_five():",
    "    assert max([4, 9, 2]) == 9",
    "",
    "def test_six():",
    "    assert {'a': 1}.get('a') == 1",
    "",
  ].join("\n"),
};

console.log("=== Installing dependencies (once) ===\n");

const base = await client.sandbox({
  image: "python:3.11-slim",
  resources: { cpu: "1", memory: "512Mi" },
  name: "shard-base",
});

let forks: Awaited<ReturnType<typeof base.fork>>[] = [];

try {
  await base.createDirectory("/workspace");
  await base.exec("pip install --quiet pytest").pipe(process.stdout);
  for (const [path, content] of Object.entries(TEST_FILES)) {
    await base.writeFile(`/workspace/${path}`, content);
  }

  const shardNames = Object.keys(TEST_FILES);
  console.log(`\n=== Forking into ${shardNames.length} shards ===\n`);

  // Promise.allSettled, not Promise.all: if one fork() rejects, the others may still have
  // succeeded server-side. allSettled lets us capture every handle that actually came back
  // (so `finally` below closes all of them, not just orphans them) before surfacing the failure.
  const forkResults = await Promise.allSettled(shardNames.map((_, i) => base.fork(`shard-${i}`)));
  forks = forkResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const forkFailures = forkResults.filter((r) => r.status === "rejected");
  if (forkFailures.length > 0) {
    throw new Error(
      `${forkFailures.length}/${shardNames.length} fork() calls failed: ` +
        forkFailures
          .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
          .join("; "),
    );
  }
  for (const [i, f] of forks.entries()) console.log(`  shard-${i} → ${f.sandboxId}`);

  console.log("\n=== Running shards in parallel ===\n");

  const shardResults = await Promise.all(
    shardNames.map(async (path, i) => {
      const sb = forks[i];
      const t0 = Date.now();
      const { stdout, exitCode } = await sb.exec(`cd /workspace && pytest -q ${path}`, {
        strict: false,
      });
      return {
        path,
        exitCode,
        ms: Date.now() - t0,
        summary: stdout.trim().split("\n").pop() ?? "",
      };
    }),
  );

  console.log("=== Shard results ===");
  let allPassed = true;
  for (const r of shardResults) {
    allPassed = allPassed && r.exitCode === 0;
    console.log(`  [${r.path}] ${r.exitCode === 0 ? "PASS" : "FAIL"} (${r.ms}ms) — ${r.summary}`);
  }
  console.log(`\nOverall: ${allPassed ? "PASS" : "FAIL"}`);
  if (!allPassed) process.exitCode = 1;
} finally {
  await Promise.all([...forks.map((f) => f.close()), base.close()]);
}
