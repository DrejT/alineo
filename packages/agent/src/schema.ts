/**
 * A single named setup step run inside the sandbox after Pi CLI install,
 * before the snapshot is taken. The step is a bash shell command.
 */
export interface SetupStep {
  /** Human-readable label shown in logs and included in the setup hash. */
  name: string;
  /** Shell command to run (bash). */
  run: string;
  /** If set, the command runs as `cd <cwd> && <run>`. */
  cwd?: string;
}

/**
 * JSON spec for an agent — typically loaded from an `agent.json` file on disk.
 * Pass the path to `Alineo.load(specPath)`.
 *
 * Environment variable references in `env` values are interpolated from
 * `process.env` at load time: `"${MY_API_KEY}"` → `process.env.MY_API_KEY`.
 */
export interface AgentSpec {
  $schema?: string;
  /** Unique identifier for this agent. Used as the sandbox session name. */
  name: string;
  /** Human-readable display name. */
  title?: string;
  description?: string;
  author?: string;
  categories?: string[];
  /** CLI to run inside the sandbox. Currently only `"pi"` is supported. */
  cli: "pi";
  /**
   * npm version specifier for the Pi CLI, e.g. `"1.2.3"`, `"^1.2.0"`, or a
   * dist-tag like `"latest"`. Passed directly to
   * `npm install -g @earendil-works/pi-coding-agent@<cliVersion>`. When
   * omitted, `install()` runs the bare package name and npm resolves
   * whatever it considers latest. Included in the setup-hash cache key, so
   * changing it forces a fresh snapshot rebuild.
   */
  cliVersion?: string;
  /**
   * AI provider passed to the CLI via `--provider`. For Pi with a direct Google
   * API key, omit this (Pi defaults to the Google Generative AI endpoint).
   */
  provider?: string;
  /**
   * Model ID passed to the CLI via `--model`.
   * For Pi 0.80.x with a free Google AI Studio key, use `"gemini-flash-latest"`
   * (Pi's alias for gemini-3.5-flash via the direct Google Generative AI API).
   */
  model?: string;
  /**
   * APT packages to install in the sandbox before starting the CLI.
   * Example: `["python3", "git"]`. `nodejs_22` and `nodejs` are silently ignored
   * since the base image is `node:22`.
   */
  packages?: string[];
  /**
   * Environment variables available inside the sandbox.
   * Values may reference host env vars: `{ GEMINI_API_KEY: "${GEMINI_API_KEY}" }`.
   */
  env?: Record<string, string>;
  /**
   * CPU/memory/GPU resource limits for the sandbox container.
   * Falls back to defaults in `alineo.config.json` if omitted.
   */
  resources?: { cpu: string; memory: string; gpu?: string };
  /** Not read anywhere in `alineo`; has no effect on the sandbox. */
  metadata?: Record<string, string>;
  /**
   * Not read by `alineo` itself — used by `alineo add`, which fetches
   * and saves each dependency spec first, depth-first.
   */
  registryDependencies?: string[];
  /**
   * Setup steps run inside the sandbox after Pi CLI install, before the snapshot.
   * Baked into the snapshot — any change to a step invalidates the cache automatically.
   * Example: create directories, write seed files, install project dependencies.
   */
  setup?: SetupStep[];
  /**
   * Remaining budget for `Alineo.spawn()` calls made from inside this agent's sandbox.
   * Translated by `Alineo.load()`/`Alineo.resume()` into the `ALINEO_SPAWN_DEPTH` env var.
   * `Alineo.spawn()` reads that value, refuses unless it's a positive integer, and
   * force-injects `value - 1` into the spawned child — a tamper-resistant counter,
   * not something a spec or the model can hand-propagate. Omit to disable spawning
   * entirely (the default — most agents never need it).
   */
  spawnDepth?: number;
  /**
   * Remaining budget for total agents this lineage may spawn — a resource
   * ceiling, distinct from `spawnDepth`'s nesting-depth limit. Translated by
   * `Alineo.load()`/`Alineo.resume()` into the `ALINEO_MAX_AGENTS` env var and
   * force-decremented into each spawned child, the same tamper-resistant
   * pattern as `spawnDepth`. Unlike `spawnDepth`, omitting this means
   * "uncapped" for this dimension, not "spawning disabled" — `spawnDepth`
   * alone still gates whether spawning is allowed at all. Enforced
   * per-lineage only: sibling branches spawned in parallel don't share or
   * coordinate this budget with each other.
   */
  maxAgents?: number;
}

export function validateAgentSpec(data: unknown): AgentSpec {
  if (!data || typeof data !== "object") throw new Error("Agent spec must be an object");
  const item = data as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name)
    throw new Error("Agent spec must have a 'name' string");
  if (item.cli !== "pi")
    throw new Error(`Unsupported CLI: '${String(item.cli ?? "(missing)")}'. Supported values: pi`);
  if (
    item.spawnDepth !== undefined &&
    (typeof item.spawnDepth !== "number" ||
      !Number.isInteger(item.spawnDepth) ||
      item.spawnDepth < 0)
  ) {
    throw new Error("Agent spec 'spawnDepth' must be a non-negative integer if set");
  }
  if (
    item.maxAgents !== undefined &&
    (typeof item.maxAgents !== "number" || !Number.isInteger(item.maxAgents) || item.maxAgents < 0)
  ) {
    throw new Error("Agent spec 'maxAgents' must be a non-negative integer if set");
  }
  return item as unknown as AgentSpec;
}
