/**
 * Integration tests for alineod — the real daemon, driving real agents.
 *
 * Starts `apps/alineod/server.ts` as a subprocess with a throwaway state directory, and talks to
 * it over HTTP exactly as a client would.
 *
 * Requires OpenSandbox running (alineo init) and NVIDIA_API_KEY in the environment — every agent
 * uses NVIDIA NIM (free tier at https://build.nvidia.com).
 *
 * Run with: NVIDIA_API_KEY=... bun test tests/integration/alineod.test.ts --timeout 900000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.NVIDIA_API_KEY) {
  throw new Error("NVIDIA_API_KEY env var is required to run tests/integration/alineod.test.ts");
}

const SERVER = join(import.meta.dir, "../../apps/alineod/server.ts");
const PORT = 46_000 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "alineod-integration-"));

function agentSpec(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    harness: "pi",
    provider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
    ...extra,
  };
}

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

async function until<T>(
  fn: () => Promise<T>,
  what: string,
  timeoutMs: number,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined as T);
    if (last) return last as NonNullable<T>;
    await Bun.sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let server: Subprocess | undefined;

async function startServer(): Promise<void> {
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
  await until(
    async () => (await api("GET", "/health")).status === 200,
    "alineod to listen",
    60_000,
  );
}

async function waitLive(agentId: string): Promise<string> {
  return until(
    async () => {
      const { body } = await api("GET", `/agents/${agentId}`);
      if (body.outcome && !body.sandboxId) throw new Error(`${agentId} ended: ${body.outcome}`);
      return body.sandboxId as string | null;
    },
    `${agentId} to provision`,
    600_000,
  );
}

/** Poll an agent's result until its text satisfies `ok` and its turn is over. */
async function waitResult(agentId: string, ok: (text: string) => boolean): Promise<string> {
  let last = "";
  try {
    return await until(
      async () => {
        const { status, body } = await api("GET", `/agents/${agentId}/result?wait=30`);
        const view = (await api("GET", `/agents/${agentId}`)).body;
        last = body.result ?? "";
        return status === 200 && view.state !== "running" && ok(last) ? last : null;
      },
      `${agentId}'s result`,
      300_000,
    );
  } catch (err) {
    throw new Error(`${(err as Error).message} — last result: ${JSON.stringify(last)}`);
  }
}

let runId: string;
let rootId: string;

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(async () => {
  if (runId) await api("DELETE", `/runs/${runId}`).catch(() => {});
  server?.kill();
  rmSync(DATA, { recursive: true, force: true });
});

describe("alineod", () => {
  test("creates a run and the root agent answers", async () => {
    const res = await api("POST", "/runs", {
      spec: agentSpec("coordinator", { spawnDepth: 2, maxAgents: 10 }),
      prompt: "Reply with exactly the word READY and nothing else.",
    });
    expect(res.status).toBe(202);
    runId = res.body.runId;
    rootId = res.body.rootAgentId;

    await waitLive(rootId);
    expect(await waitResult(rootId, (t) => t.includes("READY"))).toContain("READY");
  }, 900_000);

  test("fans out to workers and gathers their results through /inputs", async () => {
    const tokens = ["ALPHA-7", "BRAVO-3"];
    const workers: string[] = [];
    for (const token of tokens) {
      const res = await api("POST", `/runs/${runId}/agents`, {
        parentAgentId: rootId,
        spec: agentSpec(`worker-${token.toLowerCase()}`),
        prompt: `Reply with exactly the token ${token} and nothing else.`,
      });
      expect(res.status).toBe(202);
      workers.push(res.body.agentId);
    }

    const gather = await api("POST", `/runs/${runId}/agents`, {
      parentAgentId: rootId,
      spec: agentSpec("gather"),
      waitFor: workers,
      prompt:
        "Use your bash tool to run `cat /inputs.json /inputs/*.txt`. " +
        "Then reply with every token of the form WORD-DIGIT you found, separated by spaces, and nothing else.",
    });
    expect(gather.body.state).toBe("spawning");

    for (const w of workers) await waitResult(w, () => true);
    const result = await waitResult(gather.body.agentId, (t) =>
      tokens.every((tok) => t.includes(tok)),
    );
    for (const token of tokens) expect(result).toContain(token);

    const tree = await api("GET", `/runs/${runId}`);
    expect(tree.body.agents).toHaveLength(4);
    expect(
      tree.body.agents.find((a: { agentId: string }) => a.agentId === gather.body.agentId),
    ).toMatchObject({
      parentAgentId: rootId,
      depth: 1,
      outcome: "success",
    });
  }, 900_000);

  test("pauses and resumes an agent's container", async () => {
    // Resume restores the state the agent had before the pause (`paused_from`) — not always
    // `running`. The root's turn has usually finished by now, so that is `done` (or `failed`).
    const before = (await api("GET", `/agents/${rootId}`)).body.state;

    expect((await api("POST", `/agents/${rootId}/pause`)).status).toBe(202);
    const paused = await api("GET", `/agents/${rootId}`);
    expect(paused.body.state).toBe("paused");
    expect(paused.body.sessionStats).toBeUndefined();

    expect((await api("POST", `/agents/${rootId}/resume`)).status).toBe(202);
    expect((await api("GET", `/agents/${rootId}`)).body.state).toBe(before);
  }, 60_000);

  test("steers a running turn after its tool call finishes", async () => {
    const prompt = await api("POST", `/agents/${rootId}/prompt`, {
      text: "Use your bash tool to run `sleep 25 && echo slept`. When it finishes, reply with exactly the word FIRST.",
    });
    expect(prompt.status).toBe(202);
    await Bun.sleep(10_000); // inside the sleep

    expect(
      (
        await api("POST", `/agents/${rootId}/steer`, {
          message:
            "Change of plan: when the command finishes, reply with exactly the word SECOND instead.",
        })
      ).status,
    ).toBe(202);

    expect(await waitResult(rootId, (t) => t.includes("SECOND"))).toContain("SECOND");
  }, 600_000);

  test("survives kill -9: the restarted daemon reconnects to the live agent", async () => {
    const before = (await api("GET", `/agents/${rootId}`)).body.sandboxId;

    server!.kill(9);
    await server!.exited;
    await startServer();

    const after = await api("GET", `/agents/${rootId}`);
    expect(after.body.sandboxId).toBe(before);

    expect(
      (await api("POST", `/agents/${rootId}/prompt`, { text: "Reply with exactly the word BACK." }))
        .status,
    ).toBe(202);
    expect(await waitResult(rootId, (t) => t.includes("BACK"))).toContain("BACK");
  }, 600_000);
});
