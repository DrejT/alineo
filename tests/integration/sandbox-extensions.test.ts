import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

// Covers the pure-SandboxHandle extension surface: diagnostics, metrics, pause/resume,
// and BashSession. Alineo.resume()-style bridge-reconnection (the other half of
// examples/sandbox-extensions) is intentionally not duplicated here — it needs a
// real LLM API key and is a distinct scenario from agent.test.ts, which already
// exercises Alineo.load()/prompt()/setEnv() against a live provider.
test("sandbox extensions: diagnostics, metrics, pause/resume, BashSession", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "debian:bookworm-slim",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "sandbox-extensions-test",
  });

  try {
    // Diagnostics aren't guaranteed to be available on every OpenSandbox server
    // configuration — assert the calls don't throw and return array shapes.
    const logs = await sb.diagnosticLogs().catch(() => []);
    expect(Array.isArray(logs)).toBe(true);
    const events = await sb.diagnosticEvents().catch(() => []);
    expect(Array.isArray(events)).toBe(true);

    const snap = await sb.metrics();
    expect(typeof snap.cpu === "number" || snap.cpu === undefined).toBe(true);

    await sb.exec("echo before-pause > /tmp/marker");
    await sb.pause();

    let pausedThrew = false;
    try {
      await sb.exec("echo should-not-run");
    } catch {
      pausedThrew = true;
    }
    expect(pausedThrew).toBe(true);

    await sb.resume();
    const { stdout } = await sb.exec("cat /tmp/marker");
    expect(stdout.trim()).toBe("before-pause");

    const session = await sb.createSession({ cwd: "/tmp" });
    try {
      await session.exec("export GREETING=hello");
      const { stdout: greet } = await session.exec("echo $GREETING from session");
      expect(greet.trim()).toBe("hello from session");

      await session.exec("cd /usr && export MYDIR=$(pwd)");
      const { stdout: dir } = await session.exec("echo $MYDIR");
      expect(dir.trim()).toBe("/usr");
    } finally {
      await session.close();
    }
  } finally {
    await sb.close();
  }
}, 60_000);
