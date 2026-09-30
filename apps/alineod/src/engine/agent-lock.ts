/**
 * Serializes state-mutating commands against the SAME agent (pause/resume/stop): each has a real
 * `await` to the sandbox between its state check and its effect — `resumeAgent` in particular
 * runs a whole chain of them (bridge probe, maybe a full restart, multiple emits) — so two
 * concurrent commands on one agent can otherwise interleave: both pass the same stale state
 * check, or a pause lands mid-resume against a sandbox that's still coming back up.
 *
 * Same shape as fork-lock.ts's per-parent queue, applied to a different keyspace (the target
 * agent, not the parent being forked from) — kept as its own module rather than shared with it,
 * since the two lock different things for different reasons.
 */
const queues = new Map<string, Promise<unknown>>();

export function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(agentId) ?? Promise.resolve();
  // Run `fn` once the previously-queued command for this agent has settled, regardless of
  // whether it succeeded or failed — one failed command must not wedge every later one.
  const run = prior.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(agentId, tail);
  // Once this is the last queued command for the agent, forget the key — otherwise the map
  // grows for the life of the process across a long-running swarm with many commands.
  void tail.finally(() => {
    if (queues.get(agentId) === tail) queues.delete(agentId);
  });
  return run;
}
