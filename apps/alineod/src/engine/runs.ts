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

  emit(runId, null, "run_started", { runId });
  emit(runId, rootAgentId, "agent_spawned", {
    parentAgentId: null,
    runId,
    specName: agent.name,
    specJson: JSON.stringify(body.spec),
    depth: 0,
    spawnIndex: 0,
    sandboxId: agent.sandboxId,
  });

  if (body.prompt) void driveTurn(rootAgentId, body.prompt);

  return { runId, rootAgentId };
}
