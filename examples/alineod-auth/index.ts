/**
 * Demonstrates alineod's optional authentication, spec env allowlist and open-run limit, using
 * only the environment variables alineod reads at startup:
 *
 *   ALINEOD_AUTH_TOKEN=demo-token          every request except GET /health needs this bearer token
 *   ALINEOD_SPEC_ENV_ALLOW=NVIDIA_API_KEY  a spec may read only this name from alineod's environment
 *   ALINEOD_MAX_OPEN_RUNS=1                at most one open run at a time
 *
 *   1. GET /health needs no token               200
 *   2. no token, or a wrong one                 401 UNAUTHENTICATED
 *   3. a spec that reads ${HOME}                400 INVALID_ARGUMENT, before any sandbox exists
 *   4. a run with an allowed spec               202, and GET /runs lists it
 *   5. a second open run                        429 LIMIT_EXCEEDED
 *   6. close the first run, start the second    204, then 202
 *
 * No model call is made, so it needs no model key. No SDK either: plain HTTP. See README for how to
 * start alineod with these variables.
 */
const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";
const TOKEN = process.env.ALINEOD_API_KEY ?? "demo-token";

function agentSpec(name: string, env: Record<string, string>) {
  return {
    name,
    harness: { id: "pi", version: "1.2.0" },
    model: { provider: "nvidia", id: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    env,
    resources: { cpu: "500m", memory: "1Gi" },
  };
}

interface Reply {
  status: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- a tiny untyped client for the demo
  body: any;
}

/** One request. `token: null` sends no Authorization header. */
async function call(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Promise<Reply> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  return { status: res.status, body };
}

function expectStatus(step: string, reply: Reply, status: number, code?: string): void {
  const got = `${reply.status}${reply.body?.code ? ` ${reply.body.code}` : ""}`;
  if (reply.status !== status || (code !== undefined && reply.body?.code !== code)) {
    throw new Error(
      `${step}: expected ${status}${code ? ` ${code}` : ""}, got ${got}: ${JSON.stringify(reply.body)}`,
    );
  }
  console.log(`  ${step.padEnd(44)} ${got}`);
}

const opened: Array<{ runId: string; rootAgentId: string }> = [];

try {
  console.log(`alineod at ${BASE}\n`);

  console.log("1. A load balancer can probe without a credential");
  expectStatus("GET /health, no token", await call("GET", "/health", { token: null }), 200);

  console.log("\n2. Everything else needs the token");
  expectStatus(
    "GET /runs, no token",
    await call("GET", "/runs", { token: null }),
    401,
    "UNAUTHENTICATED",
  );
  expectStatus(
    "GET /runs, wrong token",
    await call("GET", "/runs", { token: "not-the-token" }),
    401,
    "UNAUTHENTICATED",
  );

  console.log("\n3. A spec may read only allowlisted names from alineod's environment");
  const leak = await call("POST", "/runs", {
    body: { spec: agentSpec("leaky", { STOLEN: "${HOME}" }) },
  });
  expectStatus("POST /runs, env reads ${HOME}", leak, 400, "INVALID_ARGUMENT");
  console.log(`  -> ${leak.body.error}`);

  console.log("\n4. An allowed spec starts a run");
  const first = await call("POST", "/runs", {
    body: { spec: agentSpec("first", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
  });
  expectStatus("POST /runs", first, 202);
  opened.push(first.body);
  const listed = await call("GET", "/runs?state=open");
  expectStatus("GET /runs?state=open", listed, 200);
  if (!listed.body.runs.some((r: { runId: string }) => r.runId === first.body.runId)) {
    throw new Error(`GET /runs did not list ${first.body.runId}`);
  }
  console.log(`  -> lists ${first.body.runId}`);

  console.log("\n5. One open run is the limit");
  const second = await call("POST", "/runs", {
    body: { spec: agentSpec("second", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
  });
  expectStatus("POST /runs, a second open run", second, 429, "LIMIT_EXCEEDED");
  console.log(`  -> ${second.body.error}`);

  console.log("\n6. Close the first run, and there is room again");
  opened.shift();
  expectStatus(
    `DELETE /runs/${first.body.runId}`,
    await call("DELETE", `/runs/${first.body.runId}`),
    204,
  );
  const third = await call("POST", "/runs", {
    body: { spec: agentSpec("second", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
  });
  expectStatus("POST /runs", third, 202);
  opened.push(third.body);

  console.log("\nDone. Closing the run this script left open.");
} finally {
  // Close what this script opened, so the next run starts under the limit.
  for (const run of opened) {
    await call("DELETE", `/runs/${run.runId}`);
  }
}
