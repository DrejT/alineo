/**
 * `alineo` CLI usage telemetry. Anonymous, allowlisted (command name + a small per-command set
 * of boolean flag presence, never argv/paths/spec contents), default-on with an explicit
 * opt-out. Wired in at the single dispatch choke point in index.ts, not per-command -- every
 * command file in commands/ stays untouched.
 */
import { join } from "node:path";
import { serverConfigDir } from "./config.js";

export interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
  /** Epoch ms of the first-run notice; null until it's been shown once. */
  notifiedAt: number | null;
}

/** Intentionally duplicated from `apps/telemetry/db.ts`'s identical interface rather than shared
 * via a workspace package -- this CLI and that app communicate purely over the `POST /v1/events`
 * HTTP contract, with no runtime/deploy dependency in either direction. */
export interface CliTelemetryEvent {
  command: string;
  flags: Record<string, boolean>;
  /** `spawn`/`fork` only -- the target spec's own `AgentSpec.provider` string (e.g. `"nvidia"`),
   * when readable. See `extractSpecProvider()`'s doc comment for why this field, not `model`. */
  specProvider?: string;
  outcome: "success" | "error";
  errorClass?: string;
  durationMs: number;
  cliVersion: string;
  osPlatform: string;
  osArch: string;
  bunVersion: string;
  isCI: boolean;
  anonymousId: string;
}

/** No production endpoint is deployed yet -- this default is a local-dev placeholder only.
 * Overridable via env var for whenever `apps/telemetry` is actually deployed, same override
 * convention `@alineo-labs/otel`'s own collector URL uses. */
const DEFAULT_TELEMETRY_ENDPOINT = "http://localhost:3002/v1/events";
const SEND_TIMEOUT_MS = 500;

/** `ALINEO_TELEMETRY_CONFIG_PATH` is an internal test seam, not a documented user-facing setting
 * (`node:os`'s `homedir()` doesn't re-read `process.env.HOME` after its first call in a process,
 * so tests can't isolate the real `serverConfigDir()` path via env mutation the way they can for
 * plain env-var-driven config elsewhere) -- defaults to the real path for every real invocation. */
function telemetryConfigPath(): string {
  return process.env.ALINEO_TELEMETRY_CONFIG_PATH ?? join(serverConfigDir(), "telemetry.json");
}

function newAnonymousId(): string {
  return crypto.randomUUID();
}

export async function readTelemetryConfig(): Promise<TelemetryConfig> {
  const file = Bun.file(telemetryConfigPath());
  if (await file.exists()) {
    const data = (await file.json()) as Partial<TelemetryConfig>;
    return {
      enabled: data.enabled ?? false,
      anonymousId: data.anonymousId ?? newAnonymousId(),
      notifiedAt: data.notifiedAt ?? null,
    };
  }
  // Default-off until apps/telemetry is actually deployed -- flip to `true` once it is.
  return { enabled: false, anonymousId: newAnonymousId(), notifiedAt: null };
}

export async function writeTelemetryConfig(config: TelemetryConfig): Promise<void> {
  await Bun.write(telemetryConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/** Checked before anything else -- either env var disables telemetry with no config file read at
 * all, matching Next.js's "check the env var before any other init logic runs" ordering.
 * `DO_NOT_TRACK` is the cross-tool convention Turborepo also honors alongside its own var.
 * Exported so `commands/telemetry.ts`'s `status` output can explain *why* telemetry is off when
 * an env var is the reason, not just the persisted config's own `enabled` flag. */
export function envDisabled(): boolean {
  return !!process.env.ALINEO_TELEMETRY_DISABLED || !!process.env.DO_NOT_TRACK;
}

export async function isTelemetryDisabled(): Promise<boolean> {
  if (envDisabled()) return true;
  const config = await readTelemetryConfig();
  return !config.enabled;
}

const FIRST_RUN_NOTICE = `[alineo] Anonymous usage telemetry: which command ran, a few known flags,
success/failure, timing -- never spec contents, prompts, or file paths. Disable any time with
'alineo telemetry disable' or ALINEO_TELEMETRY_DISABLED=1.`;

async function maybePrintFirstRunNotice(config: TelemetryConfig): Promise<void> {
  if (config.notifiedAt !== null) return;
  console.error(FIRST_RUN_NOTICE);
  await writeTelemetryConfig({ ...config, notifiedAt: Date.now() });
}

/** Bounded send, not fire-and-forget, not a blocking wait -- races the POST against a short
 * timeout so an unreachable/slow endpoint never meaningfully delays a real command's exit.
 * Never throws: a failed/slow send must not surface as a CLI error. */
export async function sendTelemetryEvent(
  event: CliTelemetryEvent,
  endpointUrl: string = process.env.ALINEO_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT,
): Promise<void> {
  try {
    await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // Unreachable endpoint, timeout, network error -- telemetry is best-effort, never a reason
    // to fail (or even warn during) a real command.
  }
}

/** Per-command allowlist of flags safe to record *presence of* -- never their values, never raw
 * argv. A flag not listed here is invisible to telemetry until someone deliberately adds it;
 * under-collecting is the only failure mode. Keys match each command's own `flag(argv, "--x")`/
 * `argv.includes("--x")` calls (see commands/spawn.ts, fork.ts, prompt.ts, agents.ts, logs.ts). */
const FLAG_ALLOWLIST: Record<string, string[]> = {
  spawn: ["--prompt", "--rebuild", "--json", "--depth", "--max", "--timeout", "--run-id"],
  fork: ["--prompt", "--json", "--depth", "--max", "--timeout"],
  prompt: ["--json", "--spec", "--timeout"],
  agents: ["--json"],
  logs: ["--json"],
  init: [],
  add: [],
  list: [],
  remove: [],
  kill: [],
};

/** Presence-only booleans for whichever flags `commandName`'s own allowlist names -- never the
 * flag's value, never anything not on the list. */
function extractAllowedFlags(commandName: string, argv: string[]): Record<string, boolean> {
  const allowed = FLAG_ALLOWLIST[commandName] ?? [];
  const flags: Record<string, boolean> = {};
  for (const flagName of allowed) {
    flags[flagName.replace(/^--/, "")] = argv.includes(flagName);
  }
  return flags;
}

/** `spawn`/`fork` take a spec file as their first non-flag argv token -- reads just its own
 * `provider` field (a small, closed, non-identifying set like `"nvidia"`/`"google"`) to answer
 * "which providers actually get used." Deliberately not `model` (closer to free text, not needed
 * for that question) and nothing else from the spec. Never throws -- a missing/unreadable spec
 * file must never surface through telemetry into the real command. */
async function extractSpecProvider(
  commandName: string,
  argv: string[],
): Promise<string | undefined> {
  if (commandName !== "spawn" && commandName !== "fork") return undefined;
  const specPath = (commandName === "fork" ? argv.slice(1) : argv).find((a) => !a.startsWith("--"));
  if (!specPath) return undefined;
  try {
    const spec = (await Bun.file(specPath).json()) as { provider?: unknown };
    return typeof spec.provider === "string" ? spec.provider : undefined;
  } catch {
    return undefined;
  }
}

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "UnknownError";
}

/**
 * Wraps a single command's `run()` call: on disabled, just calls `run()` directly (zero
 * overhead, no config read even). Otherwise times the call, records outcome/errorClass, builds
 * and sends the event, prints the first-run notice if this is the first time, and always
 * re-throws whatever `run()` threw, unchanged -- telemetry must never swallow or alter a real
 * command failure.
 */
export async function withTelemetry(
  commandName: string,
  argv: string[],
  run: () => Promise<void>,
): Promise<void> {
  if (envDisabled()) {
    await run();
    return;
  }

  const config = await readTelemetryConfig();
  if (!config.enabled) {
    await run();
    return;
  }

  await maybePrintFirstRunNotice(config);

  const flags = extractAllowedFlags(commandName, argv);
  const specProvider = await extractSpecProvider(commandName, argv);
  const start = performance.now();
  let outcome: "success" | "error" = "success";
  let errorClass: string | undefined;
  try {
    await run();
  } catch (err) {
    outcome = "error";
    errorClass = errorClassOf(err);
    throw err;
  } finally {
    const { version } = await import("../package.json");
    await sendTelemetryEvent({
      command: commandName,
      flags,
      specProvider,
      outcome,
      errorClass,
      durationMs: Math.round(performance.now() - start),
      cliVersion: version,
      osPlatform: process.platform,
      osArch: process.arch,
      bunVersion: Bun.version,
      isCI: !!process.env.CI,
      anonymousId: config.anonymousId,
    });
  }
}

/** The bare-`alineo`-launches-TUI path (index.ts) isn't a single bounded command run the way
 * `withTelemetry()` assumes -- a TUI session's own lifetime makes "wait for this before
 * proceeding" meaningless, so this only ever fires a launch count, never duration/outcome. */
export async function recordTuiLaunch(): Promise<void> {
  if (envDisabled()) return;
  const config = await readTelemetryConfig();
  if (!config.enabled) return;
  await maybePrintFirstRunNotice(config);
  const { version } = await import("../package.json");
  await sendTelemetryEvent({
    command: "tui",
    flags: {},
    outcome: "success",
    durationMs: 0,
    cliVersion: version,
    osPlatform: process.platform,
    osArch: process.arch,
    bunVersion: Bun.version,
    isCI: !!process.env.CI,
    anonymousId: config.anonymousId,
  });
}
