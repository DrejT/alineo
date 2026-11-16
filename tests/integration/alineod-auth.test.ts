/**
 * Integration test for examples/alineod-auth: alineod started with ALINEOD_AUTH_TOKEN,
 * ALINEOD_SPEC_ENV_ALLOW and ALINEOD_MAX_OPEN_RUNS refuses what it should, over real HTTP.
 *
 * Starts `apps/alineod/server.ts` as a subprocess with a throwaway state directory. Needs
 * OpenSandbox running (alineo init), because an accepted run provisions a real sandbox. Makes no
 * model call, so it needs no model key.
 *
 * Run with: bun test tests/integration/alineod-auth.test.ts --timeout 600000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "../../apps/alineod/server.ts");
const PORT = 47_000 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "alineod-auth-"));
const TOKEN = "integration-token";

function agentSpec(name: string, env: Record<string, string>) {
  return {
    name,
    harness: { id: "pi", version: "1.2.0" },
    model: { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b" },
    env,
    resources: { cpu: "500m", memory: "1Gi" },
  };
}

/** The fields these tests read. Each route returns only some of them. */
interface Body {
  runId: string;
  rootAgentId: string;
  runs: Array<{ runId: string }>;
  code?: string;
  error?: string;
  sandboxId?: string;
  outcome?: string;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: Body }> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
}

async function until(fn: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Whether alineod has closed this agent's sandbox. The HTTP view does not show it, the ledger does. */
function released(agentId: string): boolean {
  const db = new Database(join(DATA, "alineod.db"), { readonly: true });
  try {
    const row = db.query("SELECT released_at FROM agents WHERE agent_id = ?").get(agentId) as {
      released_at: number | null;
    } | null;
    return row?.released_at != null;
  } finally {
    db.close();
  }
}

let server: Subprocess | undefined;
const opened: Array<{ runId: string; rootAgentId: string }> = [];
const closed: Array<{ runId: string; rootAgentId: string }> = [];

beforeAll(async () => {
  server = Bun.spawn(["bun", SERVER], {
    cwd: DATA,
    env: {
      ...process.env,
      ALINEOD_PORT: String(PORT),
      ALINEOD_DB_PATH: join(DATA, "alineod.db"),
      ALINEOD_SDK_LEDGER_PATH: join(DATA, "sdk-ledger.db"),
      ALINEOD_MEMORY_DB_PATH: join(DATA, "memory.db"),
      ALINEOD_WORK_DIR: join(DATA, "work"),
      ALINEOD_AUTH_TOKEN: TOKEN,
      ALINEOD_SPEC_ENV_ALLOW: "NVIDIA_API_KEY",
      ALINEOD_MAX_OPEN_RUNS: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await until(
    async () => (await api("GET", "/health", { token: null })).status === 200,
    "alineod to listen",
    60_000,
  );
}, 120_000);

afterAll(async () => {
  for (const run of opened) await api("DELETE", `/runs/${run.runId}`).catch(() => {});
  closed.push(...opened.splice(0));
  // A run deleted while its sandbox is still being made gets that sandbox closed once it exists.
  // Wait for that, so this test leaves no container behind.
  for (const run of closed) {
    await until(
      () => Promise.resolve(released(run.rootAgentId)),
      `${run.rootAgentId}'s release`,
      300_000,
    );
  }
  server?.kill();
  rmSync(DATA, { recursive: true, force: true });
}, 600_000);

describe("alineod with a token, an env allowlist and an open-run limit", () => {
  test("GET /health needs no token", async () => {
    expect((await api("GET", "/health", { token: null })).status).toBe(200);
  });

  test("no token, or a wrong one, is 401", async () => {
    for (const token of [null, "not-the-token"]) {
      const res = await api("GET", "/runs", { token });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    }
  });

  test("a spec that reads a name not on the allowlist is 400", async () => {
    const res = await api("POST", "/runs", {
      body: { spec: agentSpec("leaky", { STOLEN: "${HOME}" }) },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ARGUMENT");
    expect(res.body.error).toContain("${HOME}");
  });

  test("the open-run limit refuses a second run until the first closes", async () => {
    const first = await api("POST", "/runs", {
      body: { spec: agentSpec("first", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
    });
    expect(first.status).toBe(202);
    opened.push(first.body);

    const listed = await api("GET", "/runs?state=open");
    expect(listed.status).toBe(200);
    expect(listed.body.runs.map((r) => r.runId)).toContain(first.body.runId);

    const second = await api("POST", "/runs", {
      body: { spec: agentSpec("second", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
    });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("LIMIT_EXCEEDED");

    // Deleted while its sandbox is still being made: alineod closes it when it arrives.
    expect((await api("DELETE", `/runs/${first.body.runId}`)).status).toBe(204);
    closed.push(...opened.splice(0));

    const third = await api("POST", "/runs", {
      body: { spec: agentSpec("third", { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }) },
    });
    expect(third.status).toBe(202);
    opened.push(third.body);
  }, 360_000);
});
