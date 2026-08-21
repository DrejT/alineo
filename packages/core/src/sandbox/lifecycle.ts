import { SandboxError } from "../errors";
import type { CheckpointInfo } from "../ledger";
import { LedgerEvent } from "../ledger";
import type { SandboxInternal } from "./internal";
import type { SandboxHandle } from "./sandbox";

/** Return all checkpoints for this sandbox in creation order. */
export function listCheckpoints(sb: SandboxInternal): Promise<CheckpointInfo[]> {
  return sb.deps.adapter.listCheckpoints(sb.name, sb.sandboxId);
}

/**
 * Freeze the sandbox container. Releases compute on Kubernetes; on Docker it
 * is a cgroup freeze that preserves in-memory state.
 *
 * All pending exec calls will throw `SandboxError` until `resume()` is called.
 * `close()` remains valid on a paused sandbox.
 */
export async function pause(sb: SandboxInternal): Promise<void> {
  await sb.deps.control.pauseSandbox(sb.sandboxId);
  sb.setPaused(true);
  // Same dangling-connection concern as close() — the paused container can't respond
  // to a lingering exec stream anyway, and the next exec() re-resolves a fresh client.
  sb.disposeExecClient();
  sb.clearExecClient();
  await sb.emit(LedgerEvent.SandboxPaused, -1);
  sb.deps.hooks?.onSandboxPaused?.(sb.sandboxId);
}

/**
 * Restore a paused sandbox to Running state. The execd endpoint is not
 * re-resolved here — `pause()` clears the cached client, so it's lazily
 * re-resolved on the next call that needs it (e.g. the next `exec()`).
 *
 * On Docker, this unfreezes the container instantly. On Kubernetes, a new pod
 * is created from the OCI snapshot — in-memory process state is not preserved.
 * Polls until the sandbox reports Running before returning.
 */
export async function resume(sb: SandboxInternal): Promise<void> {
  await sb.deps.control.resumeSandbox(sb.sandboxId);
  sb.setPaused(false);
  await sb.waitForRunning();
  await sb.emit(LedgerEvent.SandboxResumed, -1);
  sb.deps.hooks?.onSandboxResumed?.(sb.sandboxId);
}

/**
 * Capture a snapshot of the sandbox's current filesystem state.
 *
 * Writes a `checkpoint_created` event to the ledger with the snapshot ID and
 * returns the snapshot ID. Use `Sandbox.resume(sandboxId)` to restore from
 * the latest checkpoint, or pass the returned ID to `Sandbox.restoreSnapshot()`.
 */
export async function checkpoint(sb: SandboxInternal, name?: string): Promise<string> {
  const snap = await sb.deps.control.createSnapshot(sb.sandboxId);
  await sb.waitForSnapshot(snap.id);
  await sb.emit(LedgerEvent.CheckpointCreated, -1, { snapshotId: snap.id, name });
  sb.deps.hooks?.onCheckpoint?.(sb.sandboxId, snap.id, name);
  return snap.id;
}

/**
 * Snapshot the current sandbox and return a new independent `SandboxHandle` from that state.
 *
 * The original sandbox keeps running. Both operate on separate containers restored
 * from the same snapshot. Equivalent to `checkpoint()` followed by `Sandbox.restoreSnapshot()`
 * into a new sandbox, but without closing the original.
 *
 * @param runId  Override the forked sandbox's run correlation ID instead of inheriting
 *   whatever this sandbox's own creation closed over. Needed when forking across a process
 *   boundary (e.g. `alineo fork`, which re-`Alineo.attach()`es in a brand-new CLI process with
 *   no access to the original in-memory closure) — the caller reads the correct value from
 *   `process.env.ALINEO_RUN_ID` and passes it explicitly rather than relying on this sandbox's
 *   own (possibly unknown) default.
 */
export async function fork(
  sb: SandboxInternal,
  tag?: string,
  runId?: string,
): Promise<SandboxHandle> {
  if (!sb.deps.fork)
    throw new SandboxError("fork() is not supported on this sandbox", sb.sandboxId);
  const snap = await sb.deps.control.createSnapshot(sb.sandboxId);
  await sb.waitForSnapshot(snap.id);
  await sb.emit(LedgerEvent.CheckpointCreated, -1, { snapshotId: snap.id, name: tag });
  sb.deps.hooks?.onCheckpoint?.(sb.sandboxId, snap.id, tag);
  return sb.deps.fork(snap.id, tag, runId);
}

/**
 * Delete the sandbox container and release its resources.
 *
 * Always call `close()` when done — even on error — to avoid leaking containers.
 * Idempotent: subsequent calls are no-ops.
 */
export async function close(sb: SandboxInternal): Promise<void> {
  if (sb.isClosed()) return;
  sb.setClosed(true);
  // Close open bash sessions (best-effort — container is being deleted anyway).
  await Promise.allSettled([...sb.openSessionClosers].map((fn) => fn()));
  sb.openSessionClosers.clear();
  // Force-cancel any exec streams parseSSE deliberately left open (see its comment
  // and ExecClient.disposeConnections()) — otherwise the underlying connection sits
  // ESTABLISHED until execd's own post-completion sleep elapses, which can outlive
  // this call and leave the host process's event loop alive with nothing left to do.
  sb.disposeExecClient();
  try {
    await sb.deps.control.deleteSandbox(sb.sandboxId);
  } finally {
    await sb.emit(LedgerEvent.SandboxClosed, -1);
    sb.deps.hooks?.onSandboxClosed?.(sb.sandboxId);
    sb.deps.onClose?.();
  }
}
