/**
 * Recipe: safely run untrusted (e.g. LLM-generated) Python snippets.
 *
 * Every snippet gets its own throwaway sandbox with tight resource caps and a
 * wall-clock timeout, so a runaway or malicious snippet can't starve the host
 * or hang the batch. Failures are captured as data (never thrown) so one bad
 * snippet doesn't take down the rest of the run.
 */
import { Alineo, CommandError } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

interface RunResult {
  label: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs one untrusted snippet in its own disposable, resource-capped sandbox. */
async function runUntrusted(label: string, code: string): Promise<RunResult> {
  const sb = await client.sandbox({
    image: "python:3.11-slim",
    resources: { cpu: "250m", memory: "128Mi" }, // tight caps — this is untrusted code
    timeout: 30, // hard container lifetime (seconds)
    name: `untrusted-${label}`,
  });

  try {
    await sb.writeFile("/tmp/snippet.py", code);
    const { stdout, stderr, exitCode } = await sb.exec("python3 /tmp/snippet.py", {
      strict: false, // never throw — a non-zero exit is just a result
      timeoutMs: 5_000, // kill a runaway loop after 5s instead of hanging the batch
    });
    return { label, ok: exitCode === 0, stdout, stderr };
  } catch (e) {
    // Only connection-level failures land here — strict: false already turns
    // ordinary non-zero exits into data, but a timed-out exec still throws.
    const message = e instanceof CommandError ? e.message : (e as Error).message;
    return { label, ok: false, stdout: "", stderr: "", error: message };
  } finally {
    await sb.close();
  }
}

const snippets: Record<string, string> = {
  "well-behaved": 'print("2 + 2 =", 2 + 2)',
  raises: 'raise ValueError("bad input")',
  "infinite-loop": "while True:\n    pass",
};

console.log("Running 3 untrusted snippets in parallel, each in its own sandbox...\n");

const results = await Promise.all(
  Object.entries(snippets).map(([label, code]) => runUntrusted(label, code)),
);

for (const r of results) {
  console.log(`[${r.label}] ${r.ok ? "OK" : "FAILED"}`);
  if (r.stdout.trim()) console.log(`  stdout: ${r.stdout.trim()}`);
  if (r.stderr.trim()) console.log(`  stderr: ${r.stderr.trim().split("\n").pop()}`);
  if (r.error) console.log(`  error:  ${r.error}`);
}

const anyFailed = results.some((r) => !r.ok);
console.log(`\n${anyFailed ? "Some" : "All"} snippets handled without crashing the runner.`);
