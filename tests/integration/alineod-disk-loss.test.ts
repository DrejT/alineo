/**
 * Integration test: alineod comes back on an empty machine from the backup bucket.
 *
 * The M4 claim (durability-roadmap 4.3) end to end. Agents finish a turn with `checkpoint: true`,
 * their checkpoints are uploaded, and a full backup goes to the bucket. Then the whole data
 * directory is deleted and every agent container is removed, which is what a lost disk looks like.
 * State is restored from the bucket into a NEW directory and alineod is started on it. Each agent
 * must come back on a new container, from checkpoint turn 1, with the same Pi session and the file
 * it wrote.
 *
 * Requires OpenSandbox running (alineo init), Docker, NVIDIA_API_KEY, and an S3-compatible bucket.
 * Without all of them the suite is skipped, so a fresh checkout does not fail on it. A local MinIO:
 *
 *   docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 \
 *     minio/minio server /data
 *   docker run --rm --network host --entrypoint sh minio/mc -c \
 *     "mc alias set l http://127.0.0.1:9000 minio minio12345 && mc mb --ignore-existing l/alineod-test"
 *
 * Run with:
 *   NVIDIA_API_KEY=... ALINEOD_TEST_S3_ENDPOINT=http://127.0.0.1:9000 ALINEOD_TEST_S3_BUCKET=alineod-test \
 *   ALINEOD_TEST_S3_KEY=minio ALINEOD_TEST_S3_SECRET=minio12345 \
 *   bun test tests/integration/alineod-disk-loss.test.ts --timeout 1200000
 *
 * Litestream is not needed: the restore uses the full-backup path (`--from backup`). Litestream's
 * own replication is covered by the unit tests of its config and by the runbook run on a VPS.
 *
 * ALINEOD_TEST_AGENTS (default 2) sets how many agents are lost and restored together.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "../../apps/alineod/server.ts");
const SCRIPTS = join(import.meta.dir, "../../apps/alineod/scripts");
const PORT = 47_000 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const AGENTS = Number(process.env.ALINEOD_TEST_AGENTS ?? "2");
const MARKER = "/root/work/marker.txt";
const INSTANCE = `disk-loss-${crypto.randomUUID().slice(0, 8)}`;

const S3 = {
  ALINEOD_BACKUP_BUCKET: process.env.ALINEOD_TEST_S3_BUCKET ?? "",
  ALINEOD_BACKUP_ENDPOINT: process.env.ALINEOD_TEST_S3_ENDPOINT ?? "",
  ALINEOD_BACKUP_ACCESS_KEY_ID: process.env.ALINEOD_TEST_S3_KEY ?? "",
  ALINEOD_BACKUP_SECRET_ACCESS_KEY: process.env.ALINEOD_TEST_S3_SECRET ?? "",
  ALINEOD_BACKUP_REGION: "auto",
  ALINEOD_BACKUP_PREFIX: "disk-loss-test",
  ALINEOD_INSTANCE_ID: INSTANCE,
};

const suite = process.env.NVIDIA_API_KEY && S3.ALINEOD_BACKUP_BUCKET ? describe : describe.skip;

const OLD = mkdtempSync(join(tmpdir(), "alineod-disk-old-"));
const NEW = mkdtempSync(join(tmpdir(), "alineod-disk-new-"));

const dataEnv = (root: string) => ({
  ALINEOD_PORT: String(PORT),
  ALINEOD_DB_PATH: join(root, "alineod.db"),
  ALINEOD_SDK_LEDGER_PATH: join(root, "sdk-ledger.db"),
  ALINEOD_MEMORY_DB_PATH: join(root, "alineod-memory.db"),
  ALINEOD_WORK_DIR: join(root, "work"),
});

function agentSpec(name: string) {
  return {
    name,
    harness: "pi",
    harnessVersion: "1.2.0",
    provider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
    checkpoint: true,
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

function ledgerEvents(root: string, agentId: string) {
  const db = new Database(join(root, "alineod.db"), { readonly: true });
  try {
    return db
      .query<{ event: string; payload: string | null }, [string]>(
        "SELECT event, payload FROM ledger WHERE agent_id = ? ORDER BY seq",
      )
      .all(agentId)
      .map((r) => ({
        event: r.event,
        payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {},
      }));
  } finally {
    db.close();
  }
}

let server: Subprocess | undefined;
async function startServer(root: string): Promise<void> {
  server = Bun.spawn(["bun", SERVER], {
    cwd: root,
    env: { ...process.env, ...S3, ...dataEnv(root) },
    stdout: "inherit",
    stderr: "inherit",
  });
  await until(async () => (await api("GET", "/health")).status === 200, "alineod to listen", 90_000);
}

function script(name: string, root: string, args: string[]) {
  const run = Bun.spawnSync(["bun", join(SCRIPTS, name), ...args], {
    cwd: root,
    env: { ...process.env, ...S3, ...dataEnv(root) },
  });
  if (run.exitCode !== 0) {
    throw new Error(`${name} failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  return run.stdout.toString();
}

function removeContainer(sandboxId: string): void {
  const ps = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `name=${sandboxId}`]);
  const ids = ps.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length === 0) throw new Error(`no container found for sandbox ${sandboxId}`);
  Bun.spawnSync(["docker", "rm", "-f", ...ids]);
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

const agents: Array<{ id: string; text: string; oldSandboxId: string; oldSessionId: string }> = [];
const runIds: string[] = [];

afterAll(async () => {
  for (const id of runIds) await api("DELETE", `/runs/${id}`).catch(() => {});
  server?.kill();
  rmSync(OLD, { recursive: true, force: true });
  rmSync(NEW, { recursive: true, force: true });
});

suite("alineod: a swarm survives the loss of the whole machine's disk", () => {
  beforeAll(async () => {
    await startServer(OLD);

    // One run with a root and AGENTS - 1 children would also work. Separate runs keep this test
    // independent of spawn behaviour: it is about state, not about swarm shape.
    for (let i = 0; i < AGENTS; i++) {
      const text = `marker-${crypto.randomUUID()}`;
      const res = await api<{ runId: string; rootAgentId: string }>("POST", "/runs", {
        spec: agentSpec(`durable-${i}`),
        prompt:
          `Use your bash tool to run \`mkdir -p /root/work && printf %s ${text} > ${MARKER}\`. ` +
          "Then reply with exactly the word WRITTEN and nothing else.",
      });
      expect(res.status).toBe(202);
      runIds.push(res.body.runId);
      agents.push({ id: res.body.rootAgentId, text, oldSandboxId: "", oldSessionId: "" });
    }

    for (const a of agents) {
      await waitTurnDone(a.id, (t) => t.includes("WRITTEN"));
      // Wait for the off-box copy, not just the checkpoint: this is the thing M4 adds.
      await until(
        () =>
          Promise.resolve(
            ledgerEvents(OLD, a.id).find(
              (e) => e.event === "agent.checkpointed" && typeof e.payload.remoteRef === "string",
            ),
          ),
        `agent.checkpointed with a remoteRef for ${a.id}`,
        120_000,
      );
      const view = await agentView(a.id);
      a.oldSandboxId = view.sandboxId!;
      a.oldSessionId = view.sessionStats!.sessionId;
    }

    // A full backup to the bucket, then the disk "fails": stop alineod, delete its data, remove
    // every container. Nothing of the old machine remains except the bucket.
    script("backup.ts", OLD, [join(OLD, "backups"), "--offsite"]);
    server!.kill(9);
    await server!.exited;
    rmSync(OLD, { recursive: true, force: true });
    for (const a of agents) removeContainer(a.oldSandboxId);

    // The new machine: restore into an empty directory, start alineod there.
    script("restore.ts", NEW, ["--from", "backup"]);
    await startServer(NEW);
  }, 1_200_000);

  test("every agent is on a different sandbox", async () => {
    for (const a of agents) {
      const view = await until(
        async () => {
          const v = await agentView(a.id);
          return v.sandboxId && v.sandboxId !== a.oldSandboxId ? v : null;
        },
        `${a.id} to be restored onto a new sandbox`,
        600_000,
      );
      expect(view.sandboxId).not.toBe(a.oldSandboxId);
    }
  }, 900_000);

  test("each restore says it came from checkpoint turn 1", () => {
    for (const a of agents) {
      const restored = ledgerEvents(NEW, a.id).findLast((e) => e.event === "agent.restored");
      expect(restored?.payload).toMatchObject({ oldSandboxId: a.oldSandboxId, checkpointTurn: 1 });
    }
  });

  test("each agent kept its Pi session", async () => {
    for (const a of agents) {
      expect((await agentView(a.id)).sessionStats?.sessionId).toBe(a.oldSessionId);
    }
  }, 120_000);

  test("each agent reads back the file it wrote before the disk was lost", async () => {
    for (const a of agents) {
      expect(
        (
          await api("POST", `/agents/${a.id}/prompt`, {
            text: `Use your bash tool to run \`cat ${MARKER}\`. Reply with exactly what it printed and nothing else.`,
          })
        ).status,
      ).toBe(202);
      expect(await waitTurnDone(a.id, (t) => t.includes(a.text))).toContain(a.text);
    }
  }, 900_000);
});
