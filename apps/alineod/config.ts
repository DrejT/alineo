/**
 * alineod configuration.
 *
 * Every environment variable is declared rather than read inline, so the set is knowable: the
 * docs table is generated from these declarations (`bun run env-docs`), a rename keeps working
 * through `aliases`, and a bad value is rejected at startup instead of silently becoming `NaN`.
 *
 * `loopd` / `swarmd` were taken as names elsewhere; this is `alineod`. See research/daemon.md.
 */
import { defineEnv, readEnvGroup } from "@alineo-labs/config-shared";
import { z } from "zod";

const ms = z.coerce.number().int().positive();
const path = z.string().min(1);

/**
 * Warnings raised while reading the environment (deprecated names, so far).
 *
 * Collected rather than logged: this module is evaluated on import, which can happen before
 * `installLoggerFromEnv()` runs, and a warning written to a not-yet-installed logger would be
 * dropped. `server.ts` drains this once logging is up.
 */
export const configWarnings: string[] = [];

export const ENV_VARS = {
  PORT: defineEnv({
    name: "ALINEOD_PORT",
    description: "HTTP + SSE listen port.",
    schema: z.coerce.number().int().positive().max(65535),
    default: 4600,
  }),
  DB_PATH: defineEnv({
    name: "ALINEOD_DB_PATH",
    description:
      "alineod's own state: the append-only `ledger` plus the `agents` / `handles` projections. Separate from the SDK ledger — this one is the swarm shape, that one is per-sandbox substrate events.",
    schema: path,
    default: "./data/alineod.db",
  }),
  SDK_LEDGER_PATH: defineEnv({
    name: "ALINEOD_SDK_LEDGER_PATH",
    description:
      "The `IStorageAdapter` ledger the `alineo` SDK writes sandbox/exec/checkpoint events to. The SDK owns its schema.",
    schema: path,
    default: "./data/alineod-sdk-ledger.db",
  }),
  WORK_DIR: defineEnv({
    name: "ALINEOD_WORK_DIR",
    description:
      "Working directory alineod owns. Incoming `AgentSpec` objects are written here because the SDK's `.spawn()` takes a spec path; result blobs land here too.",
    schema: path,
    default: "./data/alineod-work",
  }),
  PROMPT_INACTIVITY_TIMEOUT_MS: defineEnv({
    name: "ALINEOD_PROMPT_INACTIVITY_MS",
    description:
      "If a driven turn's stream is silent for this long, stop reading it and follow the turn by polling Pi's state instead. The clock runs on this host, so it also ticks while the agent is paused.",
    schema: ms,
    default: 180_000,
  }),
  TURN_MAX_MS: defineEnv({
    name: "ALINEOD_TURN_MAX_MS",
    description:
      "How long catch-up follows a turn before settling with whatever text is readable. Counts only time the agent is NOT paused, so a pause never ends a turn.",
    schema: ms,
    default: 30 * 60_000,
  }),
  CATCH_UP_POLL_MS: defineEnv({
    name: "ALINEOD_CATCH_UP_POLL_MS",
    description: "Interval between Pi state polls while catching up on a turn.",
    schema: ms,
    default: 2_000,
  }),
  STATE_PROBE_TIMEOUT_MS: defineEnv({
    name: "ALINEOD_STATE_PROBE_TIMEOUT_MS",
    description: "Bound on one state probe — a frozen or dead bridge never answers.",
    schema: ms,
    default: 5_000,
  }),
  RESUME_BRIDGE_TIMEOUT_MS: defineEnv({
    name: "ALINEOD_RESUME_BRIDGE_TIMEOUT_MS",
    description: "How long resume waits for an agent's bridge to answer before restarting it.",
    schema: ms,
    default: 10_000,
  }),
  SUBTREE_MEMBER_TIMEOUT_MS: defineEnv({
    name: "ALINEOD_SUBTREE_MEMBER_TIMEOUT_MS",
    description:
      "Upper bound on one member's pause/resume inside a subtree operation, so one unresponsive sandbox can't stall the sweep (reported as `failed: timeout`).",
    schema: ms,
    default: 30_000,
  }),
  LEASE_TTL_MS: defineEnv({
    name: "ALINEOD_LEASE_TTL_MS",
    description:
      "How long the instance lease survives without a heartbeat. A second alineod on the same database refuses to start while the lease is live; after a crash, the next boot waits up to this long to take it over.",
    schema: ms,
    default: 15_000,
  }),
} as const;

const env = readEnvGroup(ENV_VARS, { onWarning: (message) => configWarnings.push(message) });

/** HTTP + SSE listen port. */
export const PORT = env.PORT;
export const DB_PATH = env.DB_PATH;
export const SDK_LEDGER_PATH = env.SDK_LEDGER_PATH;
export const WORK_DIR = env.WORK_DIR;
export const PROMPT_INACTIVITY_TIMEOUT_MS = env.PROMPT_INACTIVITY_TIMEOUT_MS;
export const TURN_MAX_MS = env.TURN_MAX_MS;
export const CATCH_UP_POLL_MS = env.CATCH_UP_POLL_MS;
export const STATE_PROBE_TIMEOUT_MS = env.STATE_PROBE_TIMEOUT_MS;
export const RESUME_BRIDGE_TIMEOUT_MS = env.RESUME_BRIDGE_TIMEOUT_MS;
export const SUBTREE_MEMBER_TIMEOUT_MS = env.SUBTREE_MEMBER_TIMEOUT_MS;
export const LEASE_TTL_MS = env.LEASE_TTL_MS;

/**
 * Bun's socket idle timeout, in seconds. Bun.serve caps this at 255 and defaults it to ~10s —
 * far too short for SSE or a long-poll. Everything below must stay under this.
 */
export const IDLE_TIMEOUT_SECONDS = 255;

/** SSE keep-alive comment interval — must be well under IDLE_TIMEOUT_SECONDS. */
export const SSE_HEARTBEAT_MS = 10_000;

/** Cap for `GET /agents/:id/result?wait=<seconds>` long-poll — must be under IDLE_TIMEOUT_SECONDS. */
export const MAX_RESULT_WAIT_SECONDS = 240;
