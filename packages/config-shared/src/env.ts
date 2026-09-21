import type { ZodType } from "zod";

/**
 * One declared environment variable.
 *
 * Declaring them instead of reading `process.env` inline is what makes the set knowable: the
 * docs table below is generated from these, so a variable can't exist without being documented,
 * and a rename keeps working through `aliases` instead of breaking someone's deployment.
 */
export interface EnvVarDef<T> {
  /** Canonical name, e.g. `ALINEOD_PORT`. */
  name: string;
  /** One line, used verbatim in the generated docs table. */
  description: string;
  /** Applied to the raw string. Use `z.coerce.number()` and friends for non-strings. */
  schema: ZodType<T>;
  /** Used when neither `name` nor any alias is set. */
  default: T;
  /** Older names, tried in order after `name`. Still honoured; reported via `onWarning`. */
  aliases?: readonly string[];
}

/** Identity helper that pins `T` from `default` while keeping the literal `name`. */
export function defineEnv<T>(def: EnvVarDef<T>): EnvVarDef<T> {
  return def;
}

export interface ReadEnvOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Called when a deprecated alias supplied the value. */
  onWarning?: (message: string) => void;
}

/**
 * Resolve one declared variable.
 *
 * Throws with the variable name and the offending value when parsing fails. `ALINEOD_PORT=abc`
 * used to become `NaN` via `Number(process.env.X ?? default)` and the daemon started anyway,
 * listening on a nonsense port; now it refuses to start and says why.
 */
export function readEnv<T>(def: EnvVarDef<T>, options: ReadEnvOptions = {}): T {
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  let raw = env[def.name];
  let source = def.name;

  if (raw === undefined) {
    for (const alias of def.aliases ?? []) {
      if (env[alias] !== undefined) {
        raw = env[alias];
        source = alias;
        options.onWarning?.(`${alias} is deprecated; use ${def.name}`);
        break;
      }
    }
  }

  if (raw === undefined) return def.default;

  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`${source}=${JSON.stringify(raw)} is not valid: ${reason}`);
  }
  return parsed.data;
}

/** Resolve a whole group of declared variables into `{ [name]: value }`. */
export function readEnvGroup<T extends Record<string, EnvVarDef<unknown>>>(
  defs: T,
  options: ReadEnvOptions = {},
): { [K in keyof T]: T[K] extends EnvVarDef<infer V> ? V : never } {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defs)) {
    out[key] = readEnv(def, options);
  }
  return out as { [K in keyof T]: T[K] extends EnvVarDef<infer V> ? V : never };
}

/**
 * Render declared variables as a Markdown table, so the docs page is generated from the same
 * declarations the code reads rather than maintained by hand beside them.
 */
export function envTable(defs: readonly EnvVarDef<unknown>[]): string {
  const rows = defs.map((def) => {
    const aliases = def.aliases?.length ? def.aliases.map((a) => `\`${a}\``).join(", ") : "—";
    return `| \`${def.name}\` | ${def.description} | \`${JSON.stringify(def.default)}\` | ${aliases} |`;
  });
  return ["| Variable | Description | Default | Older names |", "|---|---|---|---|", ...rows].join(
    "\n",
  );
}
