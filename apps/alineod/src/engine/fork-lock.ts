/**
 * Serializes concurrent `parent.spawn()` (fork) calls against the SAME parent sandbox.
 *
 * Mitigates opensandbox-group/OpenSandbox#1831: on the Docker runtime, the `docker commit`
 * `fork()` takes of the live parent has no concurrency guard — two commits fired at the same
 * sandbox at once can each come back `Ready` while silently missing files that exist on the
 * parent's live filesystem (repro: a globally npm-installed CLI missing from BOTH resulting
 * forks — and even from a third, solo commit taken ~76s later against the same, still-healthy,
 * unmodified parent, i.e. the corruption outlives the race). The Kubernetes runtime already
 * rejects a second in-flight snapshot per sandbox with 409; the Docker runtime has no such
 * protection. Until that lands upstream, alineod queues fork() calls per parent instead of
 * racing them — this is what let two children spawned in the same request burst
 * (`spawnAgent()`'s synchronous prefix accepts both, then forks them concurrently) reproduce
 * the bug in the first place. Cross-parent concurrency is untouched: two DIFFERENT agents'
 * forks still run in parallel; only two children of the SAME live parent are ever serialized.
 */
const queues = new Map<string, Promise<unknown>>();

export function withParentForkLock<T>(parentAgentId: string, fork: () => Promise<T>): Promise<T> {
  const prior = queues.get(parentAgentId) ?? Promise.resolve();
  // Run `fork` once the previously-queued fork for this parent has settled, regardless of
  // whether it succeeded or failed — one failed fork must not wedge every later sibling.
  const run = prior.then(fork, fork);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(parentAgentId, tail);
  // Once this is the last queued fork for the parent, forget the key — otherwise the map
  // grows for the life of the process across a long-running swarm with many spawns.
  void tail.finally(() => {
    if (queues.get(parentAgentId) === tail) queues.delete(parentAgentId);
  });
  return run;
}
