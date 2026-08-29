import { SandboxError } from "../errors";
import type { CheckpointInfo } from "../ledger";
import { LedgerEvent } from "../ledger";
import {
  reconstructBoundCredentials,
  resolveBoundCredential,
  type CredentialResolver,
} from "../credentials";
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
 * @param opts.resolveCredential  Resolves values for credentials this sandbox has bound whose
 *   `CredentialSource` isn't `"env"` (or whose env var has since become unset) — the vault is
 *   sidecar-runtime-only, so it never survives the fork on its own. Only relevant if this
 *   sandbox has ever called `sb.credentials.set()`; a no-op otherwise. Throws `SandboxError`
 *   if a bound credential can't be resolved rather than silently omitting it from the child.
 * @param opts.credentialProxy  Force-enables the child's credential proxy even if this sandbox
 *   has no bound credentials of its own to carry over — for a caller that plans to register
 *   brand-new credentials on the child right after `fork()` returns (this sandbox's own bound
 *   credentials, if any, always enable it regardless of this flag).
 * @param opts.resourceId  Override the forked sandbox's resource scope (see
 *   `SandboxOptions.resourceId`) instead of inheriting this sandbox's own default — for a fork
 *   that's a *different* resource, not a continuation of this one's memory (e.g.
 *   `alineo`'s `Alineo.spawn()`, where the child is a semantically different agent).
 * @param opts.teamId  Same override, for team scope (see `SandboxOptions.teamId`). Independent
 *   of `opts.resourceId` — pass either, both, or neither.
 */
export async function fork(
  sb: SandboxInternal,
  tag?: string,
  runId?: string,
  opts?: {
    resolveCredential?: CredentialResolver;
    credentialProxy?: boolean;
    resourceId?: string;
    teamId?: string;
  },
): Promise<SandboxHandle> {
  if (!sb.deps.fork)
    throw new SandboxError("fork() is not supported on this sandbox", sb.sandboxId);
  const snap = await sb.deps.control.createSnapshot(sb.sandboxId);
  await sb.waitForSnapshot(snap.id);
  await sb.emit(LedgerEvent.CheckpointCreated, -1, { snapshotId: snap.id, name: tag });
  sb.deps.hooks?.onCheckpoint?.(sb.sandboxId, snap.id, tag);

  // Reconstructed from this sandbox's own ledger, not some in-memory "currently bound" set —
  // the vault (the actual source of truth) doesn't expose a cheap way to ask "everything
  // that's live right now," and the ledger is already the mechanism `resume()` relies on for
  // the same reason.
  const entries = await sb.deps.adapter.readAll(sb.name, sb.sandboxId);
  const boundCredentials = reconstructBoundCredentials(entries);
  const needsCredentialProxy = boundCredentials.size > 0 || opts?.credentialProxy === true;
  // Same "wide open, not lockdown" default as the agent layer (packages/agent) — this only
  // exists to make the bound host(s) reachable through the sidecar, not to restrict anything.
  const networkPolicy = needsCredentialProxy
    ? { defaultAction: "allow" as const, egress: [] }
    : undefined;

  const child = await sb.deps.fork(snap.id, tag, runId, {
    networkPolicy,
    credentialProxy: needsCredentialProxy,
    resourceId: opts?.resourceId,
    teamId: opts?.teamId,
  });

  for (const [name, { binding, source }] of boundCredentials) {
    const value = await resolveBoundCredential(name, source, opts?.resolveCredential, sb.sandboxId);
    await child.credentials.set(name, value, binding, source);
  }

  return child;
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
