/**
 * Demonstrates how a command ended, beyond its exit code:
 *   1. durationMs                  — how long it ran
 *   2. timeoutMs                   — killed, signal "killed", timedOut (a best guess, see below)
 *   3. a kill from inside          — exit 137 (128 + 9), and not timedOut
 *   4. an AbortSignal              — the call rejects with AbortError and the command is interrupted
 *
 * Needs: OpenSandbox server running (bunx alineo-cli init).
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
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "exec-result",
});

try {
  console.log("── 1. durationMs ────────────────────────────────────────────");
  const quick = await sb.exec("sleep 1; echo done");
  console.log(`exit ${quick.exitCode}, ran for ${quick.durationMs} ms`);

  console.log("\n── 2. timeoutMs ─────────────────────────────────────────────");
  const slow = await sb.exec("sleep 30", { timeoutMs: 2000, strict: false });
  console.log(
    `exit ${slow.exitCode}, killed=${slow.killed}, signal=${slow.signal}, ` +
      `timedOut=${slow.timedOut}, ran for ${slow.durationMs} ms`,
  );
  // timedOut is inferred from the elapsed time. A timeout and a kill from inside the sandbox
  // look the same on the wire, so use it to explain a failure, not to decide a retry.

  console.log("\n── 3. a command that kills itself ───────────────────────────");
  const suicide = await sb.exec("sleep 1; kill -9 $$", { timeoutMs: 20_000, strict: false });
  // The shell died from SIGKILL, so the exit code is 128 + 9. It is not a timeout.
  console.log(`exit ${suicide.exitCode}, timedOut=${suicide.timedOut ?? false}`);

  console.log("\n── 4. an AbortSignal ────────────────────────────────────────");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1000);
  const started = Date.now();
  try {
    await sb.exec("sleep 60", { signal: controller.signal, strict: false });
  } catch (e) {
    console.log(`${(e as Error).name} after ${Date.now() - started} ms`);
  }
  const after = await sb.exec("pgrep -f 'sleep 60' >/dev/null && echo running || echo gone", {
    strict: false,
  });
  console.log(`the sleep is ${after.stdout.trim()}; the sandbox is still usable`);
} finally {
  await sb.close();
}
