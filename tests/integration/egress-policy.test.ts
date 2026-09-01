import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

// Requires an OpenSandbox server with the egress sidecar configured (`egress.mode = "dns+nft"`
// — `alineo init` writes this). Run with `bun run test:integration`.

function newClient() {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });
}

// ── Part A — CIDR / IP targets ───────────────────────────────────────────────

test("networkPolicy accepts a CIDR allow rule (Part A)", async () => {
  const sb = await newClient().sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "egress-cidr",
    // 0.0.0.0/0 = allow every IP. A bare domain rule for example.com on top proves both
    // target kinds coexist in one policy without the server rejecting it.
    networkPolicy: {
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "0.0.0.0/0" },
        { action: "allow", target: "example.com" },
      ],
    },
  });
  try {
    const { exitCode } = await sb.exec("curl -sS -o /dev/null -w '%{http_code}' https://example.com");
    expect(exitCode).toBe(0);
  } finally {
    await sb.close();
  }
}, 60_000);

test("a malformed networkPolicy target is rejected locally, before any server call (Part A)", async () => {
  await expect(
    newClient().sandbox({
      image: "ubuntu:22.04",
      resources: { cpu: "500m", memory: "256Mi" },
      networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "http://nope" }] },
    }),
  ).rejects.toThrow(/Invalid networkPolicy egress target/);
}, 15_000);

// ── Part C1 — runtime egress policy (sb.egress.*) ────────────────────────────

test("sb.egress.patch / delete flip reachability on a live sandbox (C1)", async () => {
  const sb = await newClient().sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "egress-runtime",
    networkPolicy: { defaultAction: "deny", egress: [] },
  });
  try {
    const reach = () =>
      sb.exec("curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://example.com").then(
        (r) => r.exitCode,
      );

    // Deny-by-default: the request fails (DNS denied → NXDOMAIN).
    expect(await reach()).not.toBe(0);

    await sb.egress.patch([{ action: "allow", target: "example.com" }]);
    expect(await reach()).toBe(0);

    await sb.egress.delete(["example.com"]);
    expect(await reach()).not.toBe(0);
  } finally {
    await sb.close();
  }
}, 90_000);

test("a runtime egress allow survives resume() (C1)", async () => {
  const client = newClient();
  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "egress-resume",
    networkPolicy: { defaultAction: "deny", egress: [] },
  });
  const sandboxId = sb.sandboxId;
  try {
    await sb.egress.patch([{ action: "allow", target: "example.com" }]);
    await sb.checkpoint();
  } finally {
    await sb.close();
  }

  const resumed = await client.resume(sandboxId);
  try {
    const { exitCode } = await resumed.exec(
      "curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://example.com",
    );
    expect(exitCode).toBe(0);
  } finally {
    await resumed.close();
  }
}, 120_000);

// ── Part B — substitution credential injection ───────────────────────────────

test("substitution injection replaces a placeholder in the query string (Part B)", async () => {
  const DEMO_SECRET = "sub-secret-not-a-real-token";
  const sb = await newClient().sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "egress-substitution",
    networkPolicy: { defaultAction: "allow", egress: [] },
    credentialProxy: true,
  });
  try {
    await sb.credentials.set("demo", DEMO_SECRET, {
      host: "httpbin.org",
      injection: { type: "substitution", placeholder: "__DEMO__", in: ["query"] },
    });

    // The request carries the literal placeholder; the sidecar swaps it for the real value.
    const { stdout } = await sb.exec("curl -s 'https://httpbin.org/get?token=__DEMO__'");
    const body = JSON.parse(stdout) as { args: Record<string, string> };
    expect(body.args.token).toBe(DEMO_SECRET);

    const { stdout: envDump } = await sb.exec("env");
    expect(envDump).not.toContain(DEMO_SECRET);
  } finally {
    await sb.close();
  }
}, 60_000);
