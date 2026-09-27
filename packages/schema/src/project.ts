/**
 * The shape of `alineo.config.json`.
 *
 * Three consumers read the same file — `packages/agent`, `packages/cli-shared` and (through
 * the Docker entrypoint) `apps/alineod` — so it cannot live in any one of them without forcing
 * the other two to depend on a package for a file none of them owns. It lived in
 * `config-shared` for that reason, which was the neutral home available at the time.
 *
 * Here now because this is the neutral home: shapes, no behaviour, and published, so a user
 * writing an `alineo.config.json` by hand can get the type from the same place the tooling
 * does. The mechanism — discovery, precedence, env overlay — stays in `config-shared`.
 *
 * Settings specific to a single consumer, such as alineod's timeouts, stay with that consumer
 * and use `defineEnv`/`loadConfig` directly.
 */
import { z } from "zod";

const ProjectConfigObject = z.object({
  /**
   * 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first, and OpenSandbox
   * typically only listens on IPv4.
   */
  serverUrl: z.string().min(1).default("http://127.0.0.1:8080"),
  /** OpenSandbox API key. Empty string for local dev with no auth. */
  apiKey: z.string().default(""),
  /**
   * Route execd and proxy traffic through the OpenSandbox server. Required when the server runs
   * in Docker (e.g. started by `alineo init`).
   */
  useServerProxy: z.boolean().default(true),
  /**
   * Anchor path used to derive the agent snapshot store location (`agent-snapshots.json` is
   * written next to it). Does not select the ledger storage adapter.
   */
  adapterPath: z.string().min(1).default("./.alineo/ledger.db"),
  /** Directory holding agent spec files. */
  agentsDir: z.string().min(1).default("./agents"),
  /**
   * Applied when an agent spec omits the field.
   *
   * `.prefault({})` rather than `.default({})`: Zod 4 uses a `default` value as-is, so
   * `.default({})` on a nested object would yield a literal `{}` and leave `cpu`/`memory`
   * undefined. `prefault` parses the value through the schema, which fills the inner defaults.
   */
  defaults: z
    .object({
      resources: z
        .object({
          cpu: z.string().min(1).default("1000m"),
          memory: z.string().min(1).default("1Gi"),
        })
        .prefault({}),
    })
    .prefault({}),
});

/**
 * In this file `null` means "not set", exactly as the hand-written reader's `??` chain used to
 * treat it. The file is hand-editable, an interrupted write can leave `{"defaults": {"resources":
 * null}}` behind, and no field here has a meaningful null value — so a stray null falls back to
 * the built-in default instead of failing validation and taking the CLI or the daemon down.
 */
function dropNulls(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null) continue;
    out[key] = dropNulls(inner);
  }
  return out;
}

/** The project config schema, with nulls treated as absent. */
export const ProjectConfigSchema = z.preprocess(dropNulls, ProjectConfigObject);

/** The underlying object schema, for JSON Schema emit (preprocess has no JSON Schema form). */
export const ProjectConfigObjectSchema = ProjectConfigObject;

export type ProjectConfig = z.infer<typeof ProjectConfigObject>;

/** `$schema` URL written into a generated `alineo.config.json`. */
export const PROJECT_CONFIG_SCHEMA_URL = "https://alineo.tech/schema/alineo.config.json";
