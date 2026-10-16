/**
 * Integration test: an agent whose container is gone is restored from its last turn checkpoint.
 *
 * This is the durability roadmap's M3 claim ("resumable to the last completed turn") run against
 * a real OpenSandbox, with a real `docker rm -f` of the agent's container. The unit tests fake the
 * SDK, so only this one fails if the restore path breaks for real.
 *
 * No model key is needed. A restore does not call a model: it provisions a fresh container,
 * extracts the checkpoint tarball and starts the bridge. The test plants a marker file and a
 * stand-in Pi session file instead of running a turn, then takes the checkpoint itself with
 * `takeCheckpoint()`, the same function alineod calls after a settled turn.
 *
 * Requires OpenSandbox running (alineo init or uvx opensandbox-server) and Docker, because the
 * test removes the container the way a reboot or a reaper would.
 *
 * Run with: bun test tests/integration/checkpoint-restore.test.ts --timeout 600000
 */
import { Alineo, checkpointsPath, takeCheckpoint } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "checkpoint-restore-"));
const LEDGER = join(DATA, "ledger.db");

// The spec needs a name-matching ledger and a model, but no turn ever runs, so the key is a dummy.
const SPEC = {
  name: "checkpoint-restore-test",
  harness: "pi" as const,
  harnessVersion: "1.2.0",
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
  env: { NVIDIA_API_KEY: "not-used-no-turn-runs" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

const MARKER = "/root/work/marker.txt";
const SESSION = "/root/.pi/agent/sessions/restore-test.jsonl";
const WORKSPACE_FILE = "/workspace/app/src/index.ts";
const WORKSPACE_DEP = "/workspace/app/node_modules/pkg/index.js";
const ROOT_DEP = "/root/work/node_modules/pkg/index.js";
const WORKSPACE_TEXT = `workspace-${crypto.randomUUID()}`;
const MARKER_TEXT = `marker-${crypto.randomUUID()}`;
const SESSION_TEXT = `{"type":"session","id":"${crypto.randomUUID()}"}`;

const adapter = new SQLiteAdapter(LEDGER);
const live: Alineo[] = [];

/** `docker rm -f` the container behind a sandbox id. OpenSandbox names it after the id. */
function removeContainer(sandboxId: string): void {
  const ps = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `name=${sandboxId}`]);
  const ids = ps.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length === 0) throw new Error(`no container found for sandbox ${sandboxId}`);
  const rm = Bun.spawnSync(["docker", "rm", "-f", ...ids]);
  if (rm.exitCode !== 0) throw new Error(`docker rm -f failed: ${rm.stderr.toString()}`);
}

afterAll(async () => {
  for (const agent of live) await agent.close().catch(() => {});
  rmSync(DATA, { recursive: true, force: true });
});

describe("restore from a turn checkpoint after the container is removed", () => {
  let originalId: string;
  let restored: Alineo;

  beforeAll(async () => {
    const agent = await Alineo.start(SPEC, { adapter });
    live.push(agent);
    originalId = agent.sandboxId;

    await agent.sandbox.exec(`mkdir -p /root/work "$(dirname ${SESSION})"`);
    await agent.sandbox.writeFile(MARKER, MARKER_TEXT);
    await agent.sandbox.writeFile(SESSION, SESSION_TEXT);
    // /workspace is where most specs work. Its source comes back. Its node_modules does not, but a
    // node_modules under /root does, because there it can hold Pi's own packages.
    await agent.sandbox.exec(
      "mkdir -p /workspace/app/src /workspace/app/node_modules/pkg /root/work/node_modules/pkg",
    );
    await agent.sandbox.writeFile(WORKSPACE_FILE, WORKSPACE_TEXT);
    await agent.sandbox.writeFile(WORKSPACE_DEP, "dep");
    await agent.sandbox.writeFile(ROOT_DEP, "dep");

    await takeCheckpoint(agent.sandbox, checkpointsPath(LEDGER), { turn: 1 });
    removeContainer(originalId);

    restored = await Alineo.resume(originalId, { adapter, spec: SPEC });
    live.push(restored);
  }, 600_000);

  test("the agent comes back on a different container", () => {
    expect(restored.sandboxId).not.toBe(originalId);
  });

  test("it reports the turn it was restored from", () => {
    expect(restored.restore).toEqual({ checkpointTurn: 1 });
  });

  test("files under /root come back, including the Pi session file", async () => {
    expect((await restored.sandbox.readFile(MARKER)).trim()).toBe(MARKER_TEXT);
    expect((await restored.sandbox.readFile(SESSION)).trim()).toBe(SESSION_TEXT);
  }, 30_000);

  test("files under /workspace come back, without its node_modules", async () => {
    expect((await restored.sandbox.readFile(WORKSPACE_FILE)).trim()).toBe(WORKSPACE_TEXT);
    const dep = await restored.sandbox.exec(`test -e ${WORKSPACE_DEP}`, { strict: false });
    expect(dep.exitCode).not.toBe(0);
  }, 30_000);

  test("a node_modules under /root is kept", async () => {
    const dep = await restored.sandbox.exec(`test -e ${ROOT_DEP}`, { strict: false });
    expect(dep.exitCode).toBe(0);
  }, 30_000);

  test("the bridge is running on the restored session", async () => {
    const state = await restored.getState();
    expect(state).toBeDefined();
  }, 30_000);

  test("the checkpoint file is on the host and retention left at least one", () => {
    const files = readdirSync(join(checkpointsPath(LEDGER), originalId));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

describe("restore with no checkpoint", () => {
  test("comes back blank, on a different container, and says so", async () => {
    const agent = await Alineo.start({ ...SPEC, name: "checkpoint-restore-blank" }, { adapter });
    live.push(agent);
    const originalId = agent.sandboxId;
    await agent.sandbox.writeFile(MARKER, MARKER_TEXT);
    removeContainer(originalId);

    const restored = await Alineo.resume(originalId, {
      adapter,
      spec: { ...SPEC, name: "checkpoint-restore-blank" },
    });
    live.push(restored);

    expect(restored.sandboxId).not.toBe(originalId);
    expect(restored.restore).toEqual({ checkpointTurn: null });
    const { exitCode } = await restored.sandbox.exec(`test -f ${MARKER}`, { strict: false });
    expect(exitCode).not.toBe(0);
  }, 600_000);
});
