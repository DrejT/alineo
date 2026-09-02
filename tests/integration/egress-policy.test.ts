import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { EgressApprovalGate, type EgressDecision } from "alineo";
import { test, expect } from "bun:test";

// Requires an OpenSandbox server with the egress sidecar configured (`egress.mode = "dns+nft"`
// — `alineo init` writes this). Run with `bun run test:integration`.
//
// `useServerProxy` defaults on: an `alineo init` (Docker) server hands out container-internal
// endpoints that aren't reachable from the host, so the sidecar APIs (credential vault,
// `/policy`) must be routed through the server. Set `OPEN_SANDBOX_SERVER_PROXY=false` for a
// bare `uvx opensandbox-server` where direct endpoints work.
const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";

// `python:*-slim` has no curl/wget but does have python3 (urllib) + getent — enough to probe
// both DNS-layer denial and real HTTP credential injection.
const IMAGE = "python:3.12-slim-bookworm";
const RESOURCES = { cpu: "500m", memory: "256Mi" };

function newClient() {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
}

/** `true` if `host` resolves from inside the sandbox (i.e. egress policy allows it). */
async function resolves(sb: SandboxHandle, host: string): Promise<boolean> {
  const { exitCode } = await sb.exec(
    `python3 -c "import socket,sys; socket.getaddrinfo('${host}', 443)"`,
    { strict: false },
  );
  return exitCode === 0;
}

/** GET a URL from inside the sandbox and return the parsed JSON body. */
async function httpGetJson(sb: SandboxHandle, url: string): Promise<unknown> {
  const { stdout } = await sb.exec(
    `python3 -c "import urllib.request,sys; sys.stdout.write(urllib.request.urlopen('${url}', timeout=15).read().decode())"`,
  );
  return JSON.parse(stdout);
}

// ── Part A — CIDR / IP targets ───────────────────────────────────────────────

test("networkPolicy accepts a CIDR allow rule alongside a domain rule (Part A)", async () => {
  const sb = await newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-cidr",
    networkPolicy: {
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "0.0.0.0/0" },
        { action: "allow", target: "example.com" },
      ],
    },
  });
  try {
    expect(await resolves(sb, "example.com")).toBe(true);
  } finally {
    await sb.close();
  }
}, 60_000);

test("a malformed networkPolicy target is rejected locally, before any server call (Part A)", async () => {
  await expect(
    newClient().sandbox({
      image: IMAGE,
      resources: RESOURCES,
      networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "http://nope" }] },
    }),
  ).rejects.toThrow(/Invalid networkPolicy egress target/);
}, 15_000);

// ── Part C1 — runtime egress policy (sb.egress.*) ────────────────────────────

test("sb.egress.patch / delete flip DNS reachability on a live sandbox (C1)", async () => {
  const sb = await newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-runtime",
    networkPolicy: { defaultAction: "deny", egress: [] },
  });
  try {
    expect(await resolves(sb, "example.com")).toBe(false);

    await sb.egress.patch([{ action: "allow", target: "example.com" }]);
    expect(await resolves(sb, "example.com")).toBe(true);

    await sb.egress.delete(["example.com"]);
    expect(await resolves(sb, "example.com")).toBe(false);
  } finally {
    await sb.close();
  }
}, 90_000);

test("sb.egress.get() reports the live policy (C1)", async () => {
  const sb = await newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-get",
    networkPolicy: { defaultAction: "deny", egress: [] },
  });
  try {
    await sb.egress.patch([{ action: "allow", target: "example.com" }]);
    const status = await sb.egress.get();
    expect(status.policy?.egress).toEqual(
      expect.arrayContaining([{ action: "allow", target: "example.com" }]),
    );
  } finally {
    await sb.close();
  }
}, 60_000);

test("a runtime egress allow survives resume() (C1)", async () => {
  const client = newClient();
  const sb = await client.sandbox({
    image: IMAGE,
    resources: RESOURCES,
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
    expect(await resolves(resumed, "example.com")).toBe(true);
  } finally {
    await resumed.close();
  }
}, 120_000);

// ── Part B — substitution credential injection ───────────────────────────────

test("substitution injection swaps a placeholder in the query string (Part B)", async () => {
  const DEMO_SECRET = "sub-secret-not-a-real-token";
  const sb = await newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-substitution",
    networkPolicy: { defaultAction: "allow", egress: [] },
    credentialProxy: true,
  });
  try {
    await sb.credentials.set("demo", DEMO_SECRET, {
      host: "httpbin.org",
      injection: { type: "substitution", placeholder: "__DEMO__", in: ["query"] },
    });
    await new Promise((r) => setTimeout(r, 1500)); // let the mitm addon reload the vault (~0.5s cache)

    const body = (await httpGetJson(sb, "https://httpbin.org/get?token=__DEMO__")) as {
      args: Record<string, string>;
    };
    expect(body.args.token).toBe(DEMO_SECRET);

    const { stdout: envDump } = await sb.exec("env");
    expect(envDump).not.toContain(DEMO_SECRET);
  } finally {
    await sb.close();
  }
}, 60_000);

// ── C2 — approve-on-egress hold (EgressApprovalGate) ─────────────────────────

const HELD = "httpbin.org"; // real + resolvable + echoes headers back, so we can see injection

const heldCred = (value = "held-secret-not-a-real-token") => [
  {
    name: "held",
    value,
    binding: {
      host: HELD,
      injection: { type: "header" as const, name: "X-Held-Credential" },
    },
  },
];

/** A sandbox in the exact posture the agent factory builds for a `approval: "hold"` binding. */
async function heldSandbox(webhookUrl?: string) {
  return newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-hold",
    networkPolicy: { defaultAction: "allow", egress: [{ action: "deny", target: HELD }] },
    credentialProxy: true,
    ...(webhookUrl ? { env: { OPENSANDBOX_EGRESS_DENY_WEBHOOK: webhookUrl } } : {}),
  });
}

async function headerSeenBy(sb: SandboxHandle): Promise<string | undefined> {
  const body = (await httpGetJson(sb, "https://httpbin.org/headers")) as {
    headers: Record<string, string>;
  };
  return body.headers["X-Held-Credential"];
}

test("EgressApprovalGate: a held host stays denied — and the credential is never registered — when the handler says deny (C2)", async () => {
  const decisions: string[] = [];
  const gate = new EgressApprovalGate({
    heldCredentials: heldCred(),
    handler: (req): EgressDecision => {
      decisions.push(req.host);
      return "deny";
    },
  });
  await gate.start();
  const sb = await heldSandbox(gate.webhookUrl);
  gate.bind(sb);
  try {
    expect(await resolves(sb, HELD)).toBe(false);
    await new Promise((r) => setTimeout(r, 800));
    expect(decisions).toContain(HELD); // the real webhook reached the handler
    expect(await resolves(sb, HELD)).toBe(false); // still denied
  } finally {
    await gate.stop();
    await sb.close();
  }
}, 90_000);

test("EgressApprovalGate: allow-once opens the host + injects, then endTurn() reverses both (C2)", async () => {
  const gate = new EgressApprovalGate({ heldCredentials: heldCred("SECRET-ONCE"), handler: () => "allow-once" });
  await gate.start();
  const sb = await heldSandbox();
  gate.bind(sb);
  try {
    // Probe first — the `exec` naturally waits out the sidecar's cold start before we drive
    // the gate (which calls `sb.egress.patch` + `sb.credentials.set` against it).
    expect(await resolves(sb, HELD)).toBe(false);
    await fetch(gate.webhookUrl.replace("172.17.0.1", "127.0.0.1"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: HELD }),
    });
    await new Promise((r) => setTimeout(r, 2000)); // rule flip + vault register + mitm reload
    expect(await headerSeenBy(sb)).toBe("SECRET-ONCE");

    await gate.endTurn();
    expect(await resolves(sb, HELD)).toBe(false); // host re-denied
  } finally {
    await gate.stop();
    await sb.close();
  }
}, 120_000);

test("the real deny webhook drives an allow-always approval end-to-end: host reachable + credential injected (C2)", async () => {
  const gate = new EgressApprovalGate({ heldCredentials: heldCred("SECRET-ALWAYS"), handler: () => "allow-always" });
  await gate.start();
  const sb = await heldSandbox(gate.webhookUrl);
  gate.bind(sb);
  try {
    // First real attempt is denied; the sidecar POSTs the webhook; the gate approves,
    // opens the rule, and registers the credential; a retry succeeds and carries it.
    expect(await resolves(sb, HELD)).toBe(false);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await headerSeenBy(sb)).toBe("SECRET-ALWAYS");
  } finally {
    await gate.stop();
    await sb.close();
  }
}, 120_000);

test("header injection still works after the injection-type change (Part B)", async () => {
  const DEMO_SECRET = "hdr-secret-not-a-real-token";
  const sb = await newClient().sandbox({
    image: IMAGE,
    resources: RESOURCES,
    name: "egress-header",
    networkPolicy: { defaultAction: "allow", egress: [] },
    credentialProxy: true,
  });
  try {
    await sb.credentials.set("demo", DEMO_SECRET, {
      host: "httpbin.org",
      injection: { type: "header", name: "X-Demo-Credential" },
    });
    await new Promise((r) => setTimeout(r, 1500)); // let the mitm addon reload the vault (~0.5s cache)

    const body = (await httpGetJson(sb, "https://httpbin.org/headers")) as {
      headers: Record<string, string>;
    };
    expect(body.headers["X-Demo-Credential"]).toBe(DEMO_SECRET);
  } finally {
    await sb.close();
  }
}, 60_000);
