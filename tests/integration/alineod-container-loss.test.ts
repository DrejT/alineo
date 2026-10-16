/**
 * Integration test: alineod restores a checkpointed agent after its container is removed.
 *
 * The full M3 claim, end to end: a real Pi agent finishes a turn, alineod checkpoints it, the
 * container is removed with `docker rm -f`, alineod restarts, and the same Pi session continues
 * on a fresh container. `checkpoint-restore.test.ts` covers the SDK half without a model. This
 * one needs a real turn, because the thing a checkpoint protects is Pi's own session file.
 *
 * Requires OpenSandbox running (alineo init), Docker, and NVIDIA_API_KEY. Without the key the
 * suite is skipped, so a fresh checkout does not fail on it.
 *
 * Run with: NVIDIA_API_KEY=... bun test tests/integration/alineod-container-loss.test.ts --timeout 900000
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "../../apps/alineod/server.ts");
const PORT = 47_000 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "alineod-container-loss-"));
const MARKER = "/root/work/marker.txt";
const MARKER_TEXT = `marker-${crypto.randomUUID()}`;

const suite = process.env.NVIDIA_API_KEY ? describe : describe.skip;

function agentSpec(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    harness: "pi",
    harnessVersion: "1.2.0",
    provider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
    ...extra,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unnecessary-type-parameters -- response bodies are asserted field by field
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
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined as T);
    if (value) return value as NonNullable<T>;
    await Bun.sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface AgentView {
  sandboxId: string | null;
  sessionStats?: { sessionId: string };
}

const agentView = async (id: string): Promise<AgentView> =>
  (await api<AgentView>("GET", `/agents/${id}`)).body;

/** Events for one agent, read straight from alineod's ledger (the HTTP route is an SSE stream). */
function ledgerEvents(agentId: string): Array<{ event: string; payload: Record<string, unknown> }> {
  const db = new Database(join(DATA, "alineod.db"), { readonly: true });
  try {
    const rows = db
      .query<{ event: string; payload: string | null }, [string]>(
        "SELECT event, payload FROM ledger WHERE agent_id = ? ORDER BY seq",
      )
      .all(agentId);
    return rows.map((r) => ({
      event: r.event,
      payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {},
    }));
  } finally {
    db.close();
  }
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

async function waitTurnDone(agentId: string, ok: (text: string) => boolean): Promise<string> {
  return until(
    async () => {
      const { status, body } = await api<{ result?: string }>(
        "GET",
        `/agents/${agentId}/result?wait=30`,
      );
      const view = (await api<{ state: string }>("GET", `/agents/${agentId}`)).body;
      const text = body.result ?? "";
      return status === 200 && view.state !== "running" && ok(text) ? text : null;
    },
    `${agentId}'s result`,
    300_000,
  );
}

function removeContainer(sandboxId: string): void {
  const ps = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `name=${sandboxId}`]);
  const ids = ps.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length === 0) throw new Error(`no container found for sandbox ${sandboxId}`);
  Bun.spawnSync(["docker", "rm", "-f", ...ids]);
}

let runId: string;
let agentId: string;

afterAll(async () => {
  if (runId) await api("DELETE", `/runs/${runId}`).catch(() => {});
  server?.kill();
  rmSync(DATA, { recursive: true, force: true });
});

suite("alineod: a checkpointed agent survives the loss of its container", () => {
  let oldSandboxId: string;
  let oldSessionId: string;

  beforeAll(async () => {
    await startServer();

    const res = await api<{ runId: string; rootAgentId: string }>("POST", "/runs", {
      spec: agentSpec("durable", { checkpoint: true }),
      prompt:
        `Use your bash tool to run \`mkdir -p /root/work && printf %s ${MARKER_TEXT} > ${MARKER}\`. ` +
        "Then reply with exactly the word WRITTEN and nothing else.",
    });
    expect(res.status).toBe(202);
    runId = res.body.runId;
    agentId = res.body.rootAgentId;

    await waitTurnDone(agentId, (t) => t.includes("WRITTEN"));
    await until(
      () => Promise.resolve(ledgerEvents(agentId).some((e) => e.event === "agent.checkpointed")),
      "agent.checkpointed",
      60_000,
    );

    const view = await agentView(agentId);
    oldSandboxId = view.sandboxId!;
    oldSessionId = view.sessionStats!.sessionId;

    removeContainer(oldSandboxId);
    server!.kill(9);
    await server!.exited;
    await startServer();
  }, 900_000);

  test("the agent is on a different sandbox", async () => {
    const view = await until(
      async () => {
        const v = await agentView(agentId);
        return v.sandboxId && v.sandboxId !== oldSandboxId ? v : null;
      },
      "the agent to be restored onto a new sandbox",
      300_000,
    );
    expect(view.sandboxId).not.toBe(oldSandboxId);
  }, 300_000);

  test("alineod records the restore, from checkpoint turn 1", () => {
    const events = ledgerEvents(agentId);
    const restored = events.findLast((e) => e.event === "agent.restored");
    expect(restored?.payload).toMatchObject({ oldSandboxId, checkpointTurn: 1 });
    const provisioned = events.findLastIndex((e) => e.event === "agent.provisioned");
    expect(events.findLastIndex((e) => e.event === "agent.restored")).toBeGreaterThan(provisioned);
  });

  test("the same Pi session continues", async () => {
    const view = await agentView(agentId);
    expect(view.sessionStats?.sessionId).toBe(oldSessionId);
  }, 60_000);

  test("the agent can read the file it wrote before the container was lost", async () => {
    expect(
      (
        await api("POST", `/agents/${agentId}/prompt`, {
          text: `Use your bash tool to run \`cat ${MARKER}\`. Reply with exactly what it printed and nothing else.`,
        })
      ).status,
    ).toBe(202);
    expect(await waitTurnDone(agentId, (t) => t.includes(MARKER_TEXT))).toContain(MARKER_TEXT);
  }, 600_000);
});
