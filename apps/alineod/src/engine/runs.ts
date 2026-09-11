/**
 * `POST /runs` — create a run: register the root agent immediately, provision it (sandbox
 * fork/install/checkpoint) in the background, drive the first turn once it's ready.
 *
 * Async by design (Track A hardening, 2026-09-11): `Alineo.load()` on a cold spec takes ~70s.
 * Blocking the HTTP request for that made every client either time out or hold a connection
 * for a minute+. The route now returns 202 the instant the row exists in the projection; the
 * caller polls `GET /runs/:id` or `GET /agents/:id` (state "provisioning" → "running"/"failed")
 * or watches `GET /runs/:id/events`.
 */
import { Alineo } from "alineo";
import type { CreateRunBody } from "../schema";
import { newRunId, newAgentId } from "../ids";
import { sdkAdapter, register } from "./registry";
import { emit } from "./emit";
import { driveTurn } from "./stream";

export interface CreateRunResult {
  runId: string;
  rootAgentId: string;
  /** Always "provisioning" at return time — poll for the real state. */
  state: string;
}

export function createRun(body: CreateRunBody): CreateRunResult {
  const runId = newRunId();
  const rootAgentId = newAgentId();

  // alineod owns the spawn-depth budget because it drives `.spawn()` from outside any sandbox
  // (the SDK's ALINEO_SPAWN_DEPTH env mechanism only applies to in-sandbox `alineo fork`).
  const specDepth = numeric(body.spec.spawnDepth);
  const specMax = numeric(body.spec.maxAgents);
  const specName = (body.spec.name as string | undefined) ?? "agent";

  // Everything above is synchronous, no I/O — this whole function runs to completion before
  // any other request's handler gets a turn, so the row below is visible to the very next
  // GET /runs/:id even though the sandbox doesn't exist yet.
  emit(runId, null, "run_started", { runId });
  emit(runId, rootAgentId, "agent_spawned", {
    parentAgentId: null,
    runId,
    specName,
    specJson: JSON.stringify(body.spec),
    depth: 0,
    spawnIndex: 0,
    sandboxId: null,
    spawnBudget: body.budget?.spawnDepth ?? specDepth ?? null,
    maxAgentsBudget: body.budget?.maxAgents ?? specMax ?? null,
  });

  void provisionRoot(runId, rootAgentId, body);

  return { runId, rootAgentId, state: "provisioning" };
}

async function provisionRoot(runId: string, rootAgentId: string, body: CreateRunBody): Promise<void> {
  try {
    const agent = await Alineo.load(body.spec, {
      adapter: sdkAdapter,
      runId,
      spawnDepth: body.budget?.spawnDepth,
      maxAgents: body.budget?.maxAgents,
    });
    register(rootAgentId, agent);
    emit(runId, rootAgentId, "agent_provisioned", { sandboxId: agent.sandboxId });

    if (body.prompt) void driveTurn(rootAgentId, body.prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(runId, rootAgentId, "agent_ended", { outcome: "failed", endedAt: Date.now(), error: message });
  }
}

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
