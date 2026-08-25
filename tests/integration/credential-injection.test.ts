import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

// Not a real secret — httpbin.org/headers just echoes back whatever it received, so this
// value round-tripping through the response body is what proves the sidecar actually injected
// it (rather than requiring a real GitHub token, unlike examples/credential-injection/index.ts).
const DEMO_SECRET = "test-secret-value-not-a-real-token";

test("credential injected transparently, never present in the sandbox's own env", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "credential-injection-test",
    networkPolicy: { defaultAction: "allow", egress: [] },
    credentialProxy: true,
  });

  try {
    await sb.credentials.set("demo", DEMO_SECRET, {
      host: "httpbin.org",
      injection: { type: "header", name: "X-Demo-Credential" },
    });

    // The sandbox's own environment never has it.
    const { stdout: envDump } = await sb.exec("env");
    expect(envDump).not.toContain(DEMO_SECRET);

    // But the sidecar injected it into the actual outbound request.
    const { stdout } = await sb.exec("curl -s https://httpbin.org/headers");
    const body = JSON.parse(stdout) as { headers: Record<string, string> };
    expect(body.headers["X-Demo-Credential"]).toBe(DEMO_SECRET);

    // Revoking stops the injection.
    await sb.credentials.remove("demo");
    const { stdout: afterRevoke } = await sb.exec("curl -s https://httpbin.org/headers");
    const bodyAfterRevoke = JSON.parse(afterRevoke) as { headers: Record<string, string> };
    expect(bodyAfterRevoke.headers["X-Demo-Credential"]).toBeUndefined();
  } finally {
    await sb.close();
  }
}, 60_000);

test("fork() carries the parent's bound credentials to the child automatically", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "credential-injection-fork-test",
    networkPolicy: { defaultAction: "allow", egress: [] },
    credentialProxy: true,
  });

  let child: SandboxHandle | undefined;
  try {
    // No `source` given — resolves as `{ type: "external" }`, so fork() needs `resolveCredential`
    // to carry it over. Exercises the "not env-derivable" path deliberately (the more common
    // env-sourced path is covered implicitly by resolveBoundCredential()'s unit-level logic).
    await sb.credentials.set("demo", DEMO_SECRET, {
      host: "httpbin.org",
      injection: { type: "header", name: "X-Demo-Credential" },
    });

    child = await sb.fork(undefined, undefined, {
      resolveCredential: (name) => (name === "demo" ? DEMO_SECRET : undefined),
    });

    const { stdout } = await child.exec("curl -s https://httpbin.org/headers");
    const body = JSON.parse(stdout) as { headers: Record<string, string> };
    expect(body.headers["X-Demo-Credential"]).toBe(DEMO_SECRET);
  } finally {
    await child?.close();
    await sb.close();
  }
}, 60_000);
