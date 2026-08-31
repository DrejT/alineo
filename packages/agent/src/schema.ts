import * as z from "zod";
import { AgentSpecValidationError } from "./errors";
import type { PermissionMode, PermissionPolicy } from "./permissions";

/** Renders an arbitrary invalid field value for an error message without risking "[object Object]". */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // JSON.stringify's type says it always returns string, but at runtime it returns
    // undefined for values it can't represent (function, symbol, undefined itself).
    const json = JSON.stringify(value) as string | undefined;
    if (json !== undefined) return json;
  } catch {
    // circular reference or similar -- fall through to the primitive-safe rendering below
  }
  return typeof value === "object" && value !== null
    ? Object.prototype.toString.call(value)
    : String(value);
}

/**
 * Opt-in alternative to a plain `AgentSpec.env` string value — instead of interpolating
 * straight into the container's environment, `credential` is registered with the sandbox's
 * `CredentialBroker` via `sb.credentials.set()` and injected transparently into outbound
 * requests to `host`. The sandbox process never sees the resolved value at all. Requires the
 * agent's sandbox to be created with `credentialProxy: true` — `Alineo.load()`/`.resume()`/
 * `.spawn()` set this automatically whenever `env` contains at least one binding like this.
 */
export interface CredentialEnvBinding {
  /** Host env var reference to resolve the real value from, e.g. `"${OPENAI_API_KEY}"`. */
  credential: string;
  /** FQDN or wildcard domain this credential is injected for. */
  host: string;
  /** Narrows the binding to requests whose path starts with this prefix. */
  pathPrefix?: string;
  /** How the credential reaches the request. */
  injection:
    | { type: "header"; name: string }
    | { type: "query"; param: string }
    | { type: "path"; segment: string };
}

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
 * Pass it to `Alineo.load(spec)` — read it from disk yourself first (e.g.
 * `await Bun.file(path).json()`) if it's not already an in-memory object.
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
   *
   * A value can instead be a `CredentialEnvBinding` to opt that one key out of plain env-var
   * interpolation entirely — the key never becomes a container env var; its value is injected
   * transparently into matching outbound requests instead. See `CredentialEnvBinding`.
   */
  env?: Record<string, string | CredentialEnvBinding>;
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
  /**
   * Durable team identity for this agent's `.resourceRef` — see `@alineo-labs/memory`'s
   * `ResourceRef.teamId`. Unset by default (unlike `resourceId`, which always gets
   * `spec.name` as its own default) — most agents aren't tied to a team-scoped memory.
   * `Alineo.load()`/`.resume()` also thread this into `SandboxOptions.teamId`/
   * `RestoreSnapshotOptions.teamId` so it stays consistent with the ledger, not just
   * `.resourceRef` — otherwise a team-scoped agent's own episodic history would be
   * unreachable through its own `resourceRef`, since `episodicRecall()` enforces `teamId`
   * strictly. `Alineo.spawn()` passes `SandboxHandle.fork()`'s `resourceId`/`teamId` override
   * (see its own doc comment) so a spawned child's ledger record matches its
   * `.resourceRef` too, rather than silently inheriting the parent's.
   */
  teamId?: string;
  /**
   * Durable resource identity for this agent's `.resourceRef` — see `@alineo-labs/memory`'s
   * `ResourceRef.resourceId`. Defaults to `spec.name` when unset, same as the implicit
   * behavior before this field existed.
   *
   * Exists as its own field, separate from `name`, specifically for `Alineo.spawn()`: a
   * spawned child's `.name` is overwritten to the forked sandbox's auto-generated ledger name
   * (`fork-<parent>-<id>`, used for `alineo agents` display and future fork labeling) — not
   * `childSpec.name`. Without a separate `resourceId` field, a spawned child's memory scope
   * would silently become that auto-generated name instead of the identity the spec author
   * actually declared. `Alineo.spawn()` freezes this to `childSpec.resourceId ?? childSpec.name`
   * before the rename happens, so a spawned child's memory scope is stable and predictable
   * regardless of what the ledger ends up calling the forked sandbox.
   */
  resourceId?: string;
  /**
   * Human-in-the-loop tool-call policy, enforced by a bundled Pi extension that runs on
   * every tool call before it executes. Either a mode shorthand (`"auto"` — the default,
   * never ask; `"ask"` — ask before every call; `"readonly"` — auto-allow reads, ask before
   * writes/exec) or a full `PermissionPolicy` with ordered per-tool / per-pattern rules
   * (last match wins). When set to anything other than `"auto"`, a `permission_request`
   * event is emitted on the agent stream for each gated call; resolve it with
   * `agent.resolvePermission(requestId, decision)`.
   */
  permissions?: PermissionMode | PermissionPolicy;
}

/**
 * Runtime schema for `SetupStep`/`AgentSpec` above. Kept as a separate Zod schema rather than
 * generating the interfaces from it (`z.infer<>`) so the hand-written interfaces above can carry
 * full field-level JSDoc — TypeScript doesn't propagate comments through generic type inference,
 * and that documentation is load-bearing (it's what IDE hover/autocomplete shows spec authors).
 * If you add/change/remove a field on `AgentSpec`/`SetupStep`, update the matching schema field
 * here too — `packages/agent/test/schema.test.ts` is the drift check.
 */
const CredentialEnvBindingSchema = z
  .object({
    credential: z.string({ error: "Each credential env binding must have a 'credential' string" }),
    host: z.string({ error: "Each credential env binding must have a 'host' string" }),
    pathPrefix: z.string().optional(),
    injection: z.union([
      z.object({ type: z.literal("header"), name: z.string() }),
      z.object({ type: z.literal("query"), param: z.string() }),
      z.object({ type: z.literal("path"), segment: z.string() }),
    ]),
  })
  .loose();

const SetupStepSchema = z
  .object({
    name: z.string({ error: "Each setup step must have a 'name' string" }),
    run: z.string({ error: "Each setup step must have a 'run' string" }),
    cwd: z.string().optional(),
  })
  .loose();

const PermissionActionSchema = z.enum(["allow", "ask", "deny", "rate_limit"]);

const PermissionRuleSchema = z
  .object({
    tool: z.string({ error: "Each permission rule must have a 'tool' string" }),
    pattern: z.string().optional(),
    action: PermissionActionSchema,
    limit: z
      .object({ count: z.number().int().positive(), windowMs: z.number().int().positive() })
      .optional(),
  })
  .loose();

const PermissionPolicySchema = z
  .object({
    default: PermissionActionSchema.optional(),
    rules: z.array(PermissionRuleSchema).optional(),
    disabledTools: z.array(z.string()).optional(),
  })
  .loose();

const PermissionsSchema = z.union([z.enum(["auto", "ask", "readonly"]), PermissionPolicySchema]);

const nonNegativeIntSpecField = (fieldName: string) =>
  z
    .number({ error: `Agent spec '${fieldName}' must be a non-negative integer if set` })
    .int(`Agent spec '${fieldName}' must be a non-negative integer if set`)
    .nonnegative(`Agent spec '${fieldName}' must be a non-negative integer if set`)
    .optional();

const AgentSpecSchema = z
  .object({
    $schema: z.string().optional(),
    name: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "Agent spec must have a 'name' string"
            : "Agent spec 'name' must be a string",
      })
      .min(1, "Agent spec must have a 'name' string"),
    title: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    categories: z.array(z.string()).optional(),
    cli: z.literal("pi", {
      error: (issue) =>
        issue.input === undefined
          ? "Agent spec must have a 'cli' field. Supported values: pi"
          : `Unsupported CLI: '${describeValue(issue.input)}'. Supported values: pi`,
    }),
    cliVersion: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    packages: z.array(z.string()).optional(),
    env: z.record(z.string(), z.union([z.string(), CredentialEnvBindingSchema])).optional(),
    resources: z
      .object({
        cpu: z.string(),
        memory: z.string(),
        gpu: z.string().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    registryDependencies: z.array(z.string()).optional(),
    setup: z.array(SetupStepSchema).optional(),
    spawnDepth: nonNegativeIntSpecField("spawnDepth"),
    maxAgents: nonNegativeIntSpecField("maxAgents"),
    teamId: z.string().optional(),
    resourceId: z.string().optional(),
    permissions: PermissionsSchema.optional(),
  })
  // Unknown keys pass through untouched rather than being stripped or rejected — matches the
  // old hand-rolled validator's behavior (it only ever checked a few fields and cast the rest
  // through) and keeps forward-compat with spec fields introduced by a newer alineo version.
  .loose();

/**
 * Validate an unknown value as an `AgentSpec`, aggregating every problem found in one pass.
 * Throws `AgentSpecValidationError` (with a pre-formatted `.message` and a structured
 * `.issues` array) rather than a bare `Error` — see #185.
 */
export function validateAgentSpec(data: unknown): AgentSpec {
  const result = AgentSpecSchema.safeParse(data);
  if (!result.success) {
    throw new AgentSpecValidationError(
      `Invalid agent spec:\n${z.prettifyError(result.error)}`,
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  return result.data;
}
