/**
 * `POST /runs` — create a run: load the root agent from a spec, open its ledger stream,
 * optionally drive one turn.
 */
import { Alineo } from "alineo";
import type { CreateRunBody } from "../schema";
import { newRunId, newAgentId } from "../ids";
import { sdkAdapter, register } from "./registry";
import { emit } from "./emit";
import { driveTurn } from "./stream";
import { HttpError } from "./errors";

export interface CreateRunResult {
  runId: string;
  rootAgentId: string;
}

export async function createRun(body: CreateRunBody): Promise<CreateRunResult> {
  const runId = newRunId();
  const rootAgentId = newAgentId();

  let agent: Alineo;
  try {
    agent = await Alineo.load(body.spec, {
      adapter: sdkAdapter,
      runId,
      spawnDepth: body.budget?.spawnDepth,
      maxAgents: body.budget?.maxAgents,
    });
  } catch (err) {
    throw new HttpError(422, `spec load failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  register(rootAgentId, agent);

  // alineod owns the spawn-depth budget because it drives `.spawn()` from outside any sandbox
  // (the SDK's ALINEO_SPAWN_DEPTH env mechanism only applies to in-sandbox `alineo fork`).
  const specDepth = numeric(body.spec.spawnDepth);
  const specMax = numeric(body.spec.maxAgents);

  emit(runId, null, "run_started", { runId });
  emit(runId, rootAgentId, "agent_spawned", {
    parentAgentId: null,
    runId,
    specName: (body.spec.name as string | undefined) ?? agent.name,
    specJson: JSON.stringify(body.spec),
    depth: 0,
    spawnIndex: 0,
    sandboxId: agent.sandboxId,
    spawnBudget: body.budget?.spawnDepth ?? specDepth ?? null,
    maxAgentsBudget: body.budget?.maxAgents ?? specMax ?? null,
  });

  if (body.prompt) void driveTurn(rootAgentId, body.prompt);

  return { runId, rootAgentId };
}

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
