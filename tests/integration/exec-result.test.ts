import { errorCodeOf, Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { describe, expect, test } from "bun:test";

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";

async function withSandbox(name: string, fn: (sb: SandboxHandle) => Promise<void>): Promise<void> {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
  const sb = await client.sandbox({
    image: "debian:bookworm-slim",
    resources: { cpu: "500m", memory: "256Mi" },
    name,
  });
  try {
    await fn(sb);
  } finally {
    await sb.close();
  }
}

describe("how a command ended", () => {
  test("durationMs says how long it ran", async () => {
    await withSandbox("exec-result-duration", async (sb) => {
      const r = await sb.exec("sleep 1; echo done");
      expect(r.exitCode).toBe(0);
      expect(r.durationMs).toBeGreaterThanOrEqual(900);
      expect(r.killed).toBeFalsy();
    });
  }, 90_000);

  test("a command stopped by timeoutMs is killed and timedOut", async () => {
    await withSandbox("exec-result-timeout", async (sb) => {
      const r = await sb.exec("sleep 30", { timeoutMs: 2000, strict: false });
      expect(r.killed).toBe(true);
      expect(r.signal).toBe("killed");
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeLessThan(15_000);
    });
  }, 90_000);

  test("a command that kills itself exits 137 and is not timedOut", async () => {
    await withSandbox("exec-result-suicide", async (sb) => {
      const r = await sb.exec("sleep 1; kill -9 $$", { timeoutMs: 20_000, strict: false });
      expect(r.exitCode).toBe(137);
      expect(r.timedOut ?? false).toBe(false);
    });
  }, 90_000);

  test("an AbortSignal rejects with AbortError and interrupts the command", async () => {
    await withSandbox("exec-result-abort", async (sb) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1000);
      const err = await Promise.resolve(
        sb.exec("sleep 60", { signal: controller.signal, strict: false }),
      ).catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");

      const after = await sb.exec("pgrep -f 'sleep 60' >/dev/null && echo running || echo gone", {
        strict: false,
      });
      expect(after.stdout.trim()).toBe("gone");
    });
  }, 90_000);

  test("a command over the size limit is refused, and writeFile is the way around it", async () => {
    await withSandbox("exec-result-big", async (sb) => {
      const big = `echo ${"x".repeat(120_000)}`;
      const err = await Promise.resolve(sb.exec(big)).catch((e: unknown) => e);
      expect(errorCodeOf(err)).toBe("INVALID_ARGUMENT");
      expect((err as { hint?: string }).hint).toContain("writeFile");

      await sb.writeFile("/tmp/big.sh", big);
      const r = await sb.exec("bash /tmp/big.sh | wc -c");
      expect(Number(r.stdout.trim())).toBe(120_001);
    });
  }, 90_000);
});
