/**
 * alineod configuration. Standalone by design — this daemon depends on the `alineo`
 * SDK (in-process) and nothing else in the repo.
 *
 * `loopd` / `swarmd` were taken as names elsewhere; this is `alineod`. See research/daemon.md.
 */

/** HTTP + SSE listen port. */
export const PORT = Number(process.env.ALINEOD_PORT ?? 4600);

/**
 * alineod's own state: the append-only `ledger` plus the `agents` / `handles` projections
 * (research/daemon.md §4). Separate file from the SDK ledger below — different concern:
 * this one is the swarm shape, that one is per-sandbox substrate events.
 */
export const DB_PATH = process.env.ALINEOD_DB_PATH ?? "./data/alineod.db";

/**
 * The `IStorageAdapter` ledger the `alineo` SDK writes sandbox/exec/checkpoint events to.
 * alineod passes one instance of `@alineo-labs/sqlite`'s adapter to every `Alineo.load()` /
 * `.resume()`; the SDK owns its schema.
 */
export const SDK_LEDGER_PATH =
  process.env.ALINEOD_SDK_LEDGER_PATH ?? "./data/alineod-sdk-ledger.db";

/**
 * Working directory alineod owns. Incoming `AgentSpec` objects are written here as files
 * because the SDK's `.spawn()` takes a spec *path* (D-b in research/daemon.md — "accept the
 * object, own the dir"). Result blobs land here too (D-d — real impl is a
 * by-reference `fs://` into the sandbox).
 */
export const WORK_DIR = process.env.ALINEOD_WORK_DIR ?? "./data/alineod-work";

/**
 * Bun's socket idle timeout, in seconds. Bun.serve caps this at 255 and defaults it to ~10s —
 * far too short for SSE or a long-poll. Everything below must stay under this.
 */
export const IDLE_TIMEOUT_SECONDS = 255;

/** SSE keep-alive comment interval — must be well under IDLE_TIMEOUT_SECONDS. */
export const SSE_HEARTBEAT_MS = 10_000;

/** Cap for `GET /agents/:id/result?wait=<seconds>` long-poll — must be under IDLE_TIMEOUT_SECONDS. */
export const MAX_RESULT_WAIT_SECONDS = 240;

/**
 * If a driven turn's stream produces no activity for this long, alineod stops reading it and
 * follows the turn by polling Pi's state instead (`catchUpTurn`). The SDK's timeout only stops
 * the reader — Pi keeps working and usually finishes (verified live,
 * research/subtree-controls-verification.md V2). The clock runs on this host, so it also fires
 * while the agent is paused.
 */
export const PROMPT_INACTIVITY_TIMEOUT_MS = Number(
  process.env.ALINEOD_PROMPT_INACTIVITY_MS ?? 180_000,
);

/**
 * How long catch-up keeps following a turn before giving up and settling with whatever text is
 * readable. Counts only time the agent is NOT paused, so a pause never ends a turn.
 */
export const TURN_MAX_MS = Number(process.env.ALINEOD_TURN_MAX_MS ?? 30 * 60_000);

/** Interval between Pi state polls while catching up on a turn. */
export const CATCH_UP_POLL_MS = Number(process.env.ALINEOD_CATCH_UP_POLL_MS ?? 2_000);

/** Bound on one state probe — a frozen or dead bridge never answers. */
export const STATE_PROBE_TIMEOUT_MS = Number(process.env.ALINEOD_STATE_PROBE_TIMEOUT_MS ?? 5_000);

/** How long resume waits for an agent's bridge to answer before restarting the bridge. */
export const RESUME_BRIDGE_TIMEOUT_MS = Number(
  process.env.ALINEOD_RESUME_BRIDGE_TIMEOUT_MS ?? 10_000,
);

/**
 * Upper bound on one member's pause/resume inside a subtree operation, so one unresponsive
 * sandbox can't stall the whole sweep (it's reported as `failed: timeout`). Resume can include a
 * bridge check and restart, hence the generous default.
 */
export const SUBTREE_MEMBER_TIMEOUT_MS = Number(
  process.env.ALINEOD_SUBTREE_MEMBER_TIMEOUT_MS ?? 30_000,
);
