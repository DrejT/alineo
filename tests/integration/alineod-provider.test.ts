/**
 * alineod runs on the configured sandbox provider and reports which one.
 *
 * Starts `apps/alineod/server.ts` as a subprocess with a throwaway state directory. The agent
 * gets a sandbox but is never prompted, so no model quota is used.
 *
 * Requires OpenSandbox running (alineo init) and NVIDIA_API_KEY in the environment, which the
 * spec's `env` resolves from alineod's own environment.
 *
 * Run with: NVIDIA_API_KEY=... bun test tests/integration/alineod-provider.test.ts --timeout 600000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.NVIDIA_API_KEY) {
  throw new Error("NVIDIA_API_KEY env var is required to run tests/integration/alineod-provider.test.ts");
}

const SERVER = join(import.meta.dir, "../../apps/alineod/server.ts");
const PORT = 47_000 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "alineod-provider-"));

const spec = {
  name: "alineod-provider-test",
  harness: { id: "pi", version: "1.2.0" },
  model: { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b" },
  env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

// oxlint-disable-next-line typescript/no-explicit-any -- response bodies are asserted field by field
async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

let server: Subprocess | undefined;
let runId: string | undefined;

beforeAll(async () => {
  server = Bun.spawn(["bun", SERVER], {
    cwd: DATA,
    env: {
      ...process.env,
      ALINEOD_PORT: String(PORT),
      ALINEOD_DB_PATH: join(DATA, "alineod.db"),
      ALINEOD_SDK_LEDGER_PATH: join(DATA, "sdk-ledger.db"),
      ALINEOD_WORK_DIR: join(DATA, "work"),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await api("GET", "/health").catch(() => ({ status: 0 }))).status === 200) return;
    await Bun.sleep(500);
  }
  throw new Error("alineod did not start listening");
}, 90_000);

afterAll(async () => {
  if (runId) await api("DELETE", `/runs/${runId}`).catch(() => {});
  server?.kill();
  rmSync(DATA, { recursive: true, force: true });
});

describe("alineod and the sandbox provider", () => {
  test("an agent reports the provider that owns its sandbox, in the view and the run tree", async () => {
    const created = await api("POST", "/runs", { spec });
    expect(created.status).toBe(202);
    runId = created.body.runId as string;
    const rootId = created.body.rootAgentId as string;

    const deadline = Date.now() + 300_000;
    let view = (await api("GET", `/agents/${rootId}`)).body;
    while (!view.sandboxId && Date.now() < deadline) {
      if (view.outcome) throw new Error(`agent ended before it started: ${view.outcome}`);
      await Bun.sleep(3_000);
      view = (await api("GET", `/agents/${rootId}`)).body;
    }

    expect(view.sandboxId).toBeTruthy();
    expect(view.provider).toBe("opensandbox");

    const tree = (await api("GET", `/runs/${runId}`)).body;
    expect(tree.agents.map((a: { provider: string | null }) => a.provider)).toEqual(["opensandbox"]);
  }, 400_000);

  test("an agent that is not live is refused with 409", async () => {
    const res = await api("POST", "/agents/a_missing/prompt", { text: "hi" });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe("string");
  });
});
