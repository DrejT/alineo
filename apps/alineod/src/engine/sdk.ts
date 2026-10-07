/**
 * The one door through which alineod creates, restarts or reconnects an `Alineo` agent.
 *
 * Every agent has to be handed the shared memory store (`opts.memory`) and the shared SDK ledger
 * adapter, and the SDK treats both as optional: forget either and the code compiles, runs, and
 * produces an agent with no memory (or one writing to the wrong ledger) with nothing to say so.
 * That was a convention each call site had to remember. Here it is a property of the only
 * functions that exist — call sites pass what is specific to them (spec, run, budgets) and cannot
 * pass, or omit, the rest.
 *
 * `test/sdk-entrypoint.test.ts` fails the build if anything else in `src/` calls
 * `Alineo.start/resume/reattach/attach/load` directly, so a fifth call site has to come through
 * here too.
 */
import { Alineo } from "alineo";
import { register, sdkAdapter } from "./registry";
import { memoryOptions } from "./memory";

/** What alineod owns, and so what a call site may not (and need not) pass. */
type Owned = "adapter" | "memory";

type StartOpts = Omit<Parameters<typeof Alineo.start>[1], Owned>;
type ResumeOpts = Omit<Parameters<typeof Alineo.resume>[1], Owned>;
type ReattachOpts = Omit<Parameters<typeof Alineo.reattach>[1], Owned>;

export function sdkStart(spec: Parameters<typeof Alineo.start>[0], opts: StartOpts) {
  return Alineo.start(spec, { ...opts, adapter: sdkAdapter, ...memoryOptions() });
}

export function sdkResume(sandboxId: string, opts: ResumeOpts) {
  return Alineo.resume(sandboxId, { ...opts, adapter: sdkAdapter, ...memoryOptions() });
}

export function sdkReattach(sandboxId: string, opts: ReattachOpts) {
  return Alineo.reattach(sandboxId, { ...opts, adapter: sdkAdapter, ...memoryOptions() });
}

/**
 * Restart a live agent's bridge in place: `resume()` it from its persisted spec and swap the new
 * handle into the registry. The one implementation behind both "the bridge stopped answering
 * mid-turn" (stream.ts) and "it didn't answer after unpausing" (pause.ts); each keeps its own
 * logging and its own policy for what a failure means, and neither can drift from the other on
 * what a restart consists of.
 */
export async function restartBridge(
  agentId: string,
  sandboxId: string,
  row: { spec_json: string; run_id: string },
): Promise<void> {
  const restarted = await sdkResume(sandboxId, {
    spec: JSON.parse(row.spec_json) as Record<string, unknown>,
    runId: row.run_id,
  });
  register(agentId, restarted);
}
