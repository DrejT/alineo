import type { SandboxHooks } from "@alineo-labs/core";
import type { Memory } from "./memory";
import type { ResourceRef } from "./types";

export interface MemoryLifecycleHooksOptions {
  /** Working-memory key the last checkpoint's metadata is stored under. */
  checkpointKey?: string;
  /** Working-memory key the most recently active sandboxId is stored under. */
  sessionKey?: string;
  /** Called when a working-memory write triggered by a hook fails. Hooks (per
   *  `@alineo-labs/core`'s own `composeHooks` convention) must never throw or reject
   *  unhandled — one broken write here must not break the sandbox operation that
   *  triggered it. Defaults to a no-op; the write is simply dropped. */
  onError?: (error: unknown) => void;
}

/** Metadata recorded under `checkpointKey` by `onCheckpoint`. */
export interface LastCheckpointRecord {
  sandboxId: string;
  snapshotId: string;
  name?: string;
  at: number;
}

const DEFAULT_CHECKPOINT_KEY = "__alineo_memory_lastCheckpoint";
const DEFAULT_SESSION_KEY = "__alineo_memory_lastSessionId";

/**
 * Binds a `Memory` instance into a sandbox's lifecycle via the existing `SandboxHooks`
 * extension point (`SandboxOptions.hooks`, composable with `composeHooks()`) rather than any
 * change to `@alineo-labs/core`'s sandbox lifecycle code itself — the safest place to hang
 * this: `SandboxHooks` already exists specifically so cross-cutting concerns like this one
 * (otel tracing, billing, and now memory) can observe lifecycle events without core needing
 * to know they exist.
 *
 * Records, in working memory scoped to `ref`:
 * - the most recently active `sandboxId` for this resource (`onSandboxCreated`)
 * - the most recent checkpoint's `{sandboxId, snapshotId, name, at}` (`onCheckpoint`)
 *
 * This does not restore or replay any state on resume — restoring a sandbox's filesystem
 * from a snapshot is `@alineo-labs/core`'s job, not this package's. What it gives an agent is
 * a durable answer to "what was the last checkpoint for this resource, across however many
 * sandbox sessions it's had" without re-deriving it from the ledger every time.
 *
 * @example
 * ```ts
 * import { composeHooks } from "@alineo-labs/core";
 * import { createMemoryLifecycleHooks } from "@alineo-labs/memory";
 *
 * const sb = await client.sandbox({
 *   image: "node:22",
 *   resources: { cpu: "500m", memory: "512Mi" },
 *   resourceId: ref.resourceId,
 *   hooks: composeHooks([createMemoryLifecycleHooks(memory, ref), otelHooks(tracer)]),
 * });
 * ```
 */
export function createMemoryLifecycleHooks(
  memory: Memory,
  ref: ResourceRef,
  opts: MemoryLifecycleHooksOptions = {},
): SandboxHooks {
  const checkpointKey = opts.checkpointKey ?? DEFAULT_CHECKPOINT_KEY;
  const sessionKey = opts.sessionKey ?? DEFAULT_SESSION_KEY;
  const onError = opts.onError ?? (() => {});

  return {
    onSandboxCreated(sandboxId) {
      memory.workingMemory.set(ref, sessionKey, sandboxId).catch(onError);
    },
    onCheckpoint(sandboxId, snapshotId, name) {
      const record: LastCheckpointRecord = { sandboxId, snapshotId, name, at: Date.now() };
      memory.workingMemory.set(ref, checkpointKey, record).catch(onError);
    },
  };
}
