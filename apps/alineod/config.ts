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
export const SDK_LEDGER_PATH = process.env.ALINEOD_SDK_LEDGER_PATH ?? "./data/alineod-sdk-ledger.db";

/**
 * Working directory alineod owns. Incoming `AgentSpec` objects are written here as files
 * because the SDK's `.spawn()` takes a spec *path* (D-b in research/daemon.md — "accept the
 * object, own the dir"). Prototype result blobs land here too (D-d — real impl is a
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
 * If a driven turn produces no stream activity for this long, give up on it — the turn's
 * handle settles (failed, or success if partial text exists) instead of hanging the swarm.
 * Some NIM models stall mid-turn on multi-tool-call turns (see the pi-bridge notes).
 */
export const PROMPT_INACTIVITY_TIMEOUT_MS = Number(process.env.ALINEOD_PROMPT_INACTIVITY_MS ?? 180_000);
