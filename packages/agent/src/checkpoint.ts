import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LedgerEvent, type SandboxHandle } from "@alineo-labs/core";

/**
 * Turn-level checkpointing (durability-roadmap.md M3, 3.2) — deliberately NOT
 * `sb.checkpoint()`. That method calls OpenSandbox's own snapshot primitive, which on the
 * Docker runtime is literally `docker commit` (confirmed against OpenSandbox's own source,
 * M3's 3.1 research) — measured at 44.3s for a 236MB container, re-exporting the whole
 * filesystem every time regardless of how much actually changed. Calling that every turn would
 * silently reintroduce the exact cost 3.1 ruled out. This module tars a few directories via
 * `sb.exec()` instead — measured at well under 2s even unfiltered.
 *
 * This is a different mechanism from the agent SDK's other "snapshot" concept, the setup
 * snapshot (`./snapshots.ts`'s `AgentSnapshotStore`) — that one is taken once per unique
 * `(specName, setupHash)` to skip reinstalling Pi/packages on every `Alineo.start()`. This one
 * is taken after every completed turn, captures that specific conversation's state (not a
 * shared install), and is what `Alineo.resume()` restores from when the container itself is
 * gone (3.3) — the setup snapshot only gets a fresh, *empty* container, not this agent's actual
 * conversation.
 */

/** Directories/globs left out of every checkpoint tarball by default — universally-safe
 * package/toolchain caches, nothing else (3.1's decision: err toward inclusion, since the
 * measured unfiltered cost is already cheap — losing real workspace state by over-excluding is
 * a worse mistake than a few extra seconds). Paths are relative to `CHECKPOINT_ROOT`. */
export const DEFAULT_CHECKPOINT_EXCLUDES = [
  ".npm",
  ".cache",
  ".cargo/registry/cache",
  "go/pkg/mod/cache/download",
];

/** Matched at any depth, not just directly under `CHECKPOINT_ROOT` — unlike the excludes
 * above, these can recur inside a workspace's own subdirectories (e.g. a cloned repo's own
 * `__pycache__`), not only at the top level. */
const DEFAULT_CHECKPOINT_EXCLUDE_GLOBS = ["__pycache__", ".pytest_cache"];

/**
 * The directory tarred into every checkpoint — Pi's home directory, where its session file
 * (`.pi/agent/sessions/...`) and whatever the agent wrote both live. Every sandbox measured for
 * 3.1 ran Pi as root; a spec that runs as a different user is a known simplification this
 * chunk doesn't yet handle (no portable way to ask a sandbox its $HOME without an extra exec
 * round trip on every checkpoint, and nothing in the current fleet needs it).
 */
export const CHECKPOINT_ROOT = "root";

export interface CheckpointRecord {
  /** Monotonic within this `Alineo` instance's lifetime — an ordinal for humans reading
   * `alineo logs`, not the mechanism restore uses to find the latest one (that's ledger
   * append order, via `AgentCheckpointed` events). Resets to 0 across a resume/reattach — a
   * fresh process starting its own count at 0 again causes no restore-correctness issue. */
  turn: number;
  /** A path on the host filesystem today (single-node M3 scope). M4 moves this off-box. */
  snapshotRef: string;
  createdAt: number;
}

/** Derive the checkpoints directory from the ledger adapter's own path, same convention as
 * `./snapshots.ts`'s `snapshotsPath()`. */
export function checkpointsPath(adapterPath: string): string {
  return join(dirname(adapterPath), "checkpoints");
}

/**
 * Tar `CHECKPOINT_ROOT` (minus the default excludes) inside the sandbox, pull the bytes out
 * byte-safe (`sb.readFileBytes()`, never `readFile()`'s UTF-8 path — a gzip tarball is not
 * valid UTF-8), write them to `checkpointsDir`, and record `AgentCheckpointed` on the sandbox's
 * own ledger — in that order, snapshot-then-event, so a checkpoint event is never written
 * pointing at a tarball that doesn't actually exist on disk.
 *
 * Throws on any step's failure (tar inside the sandbox, the byte-safe download, or the host
 * write) — the caller decides whether a failed checkpoint should interrupt the turn it was
 * taken after (3.2's own call site treats it as best-effort and logs rather than throws
 * further, since a checkpoint failing is not the same failure as the turn itself failing).
 */
export async function takeCheckpoint(
  sb: SandboxHandle,
  checkpointsDir: string,
  opts: { turn: number; excludeGlobs?: string[] },
): Promise<CheckpointRecord> {
  const tmpTarPath = `/tmp/alineo-checkpoint-${crypto.randomUUID()}.tar.gz`;
  const excludeArgs = [
    ...DEFAULT_CHECKPOINT_EXCLUDES.map((p) => `--exclude=${CHECKPOINT_ROOT}/${p}`),
    ...DEFAULT_CHECKPOINT_EXCLUDE_GLOBS.map((p) => `--exclude=*/${p}`),
    ...(opts.excludeGlobs ?? []).map((p) => `--exclude=${p}`),
  ];
  try {
    // Default strict:true — a nonzero exit throws CommandError, which this function
    // deliberately lets propagate (see this module's doc comment on failure handling).
    await sb.exec(`tar czf ${tmpTarPath} -C / ${excludeArgs.join(" ")} ${CHECKPOINT_ROOT}`);
    const bytes = await sb.readFileBytes(tmpTarPath);
    const createdAt = Date.now();
    const dir = join(checkpointsDir, sb.sandboxId);
    await mkdir(dir, { recursive: true });
    const snapshotRef = join(dir, `${opts.turn}-${createdAt}.tar.gz`);
    await writeFile(snapshotRef, bytes);
    await sb.emit(LedgerEvent.AgentCheckpointed, -1, { turn: opts.turn, snapshotRef });
    return { turn: opts.turn, snapshotRef, createdAt };
  } finally {
    // Best-effort — the temp file is inside an ephemeral container anyway, and a failure here
    // must never mask the real result (success or the error thrown above).
    try {
      await sb.exec(`rm -f ${tmpTarPath}`, { strict: false });
    } catch {
      /* best-effort cleanup only */
    }
  }
}
