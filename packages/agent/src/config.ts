import { loadProjectConfig, type ProjectConfig } from "@alineo-labs/config-shared";

/**
 * Shape of `alineo.config.json`, merged with built-in defaults.
 *
 * The schema and the merge live in `@alineo-labs/config-shared` because three consumers read
 * this same file (this package, `@alineo-labs/cli-shared`, and alineod through its Docker
 * entrypoint). That package is private and bundled at build time, so nothing new is resolved at
 * runtime for anyone installing `alineo`.
 */
export type AlineoAgentConfig = ProjectConfig;

/**
 * Resolved configs, keyed by the directory they were resolved from.
 *
 * The previous implementation re-read the file on every `load`/`resume`/`attach`/`spawn`. The
 * cache lives here rather than in `config-shared` on purpose: that package is bundled separately
 * into each consumer, so a cache inside it would be a different cache per copy. Keeping the
 * state here means one cache per process that actually uses it.
 */
const cache = new Map<string, AlineoAgentConfig>();

/**
 * Resolve the project config once per working directory.
 *
 * Unlike the old reader, this walks up from the current directory to find
 * `alineo.config.json` (bounded by a `.git` directory, `$HOME`, or the filesystem root), so
 * running a script from a subdirectory no longer silently falls back to defaults. Pass
 * `override` — `opts.config` on the public methods — to skip file and environment discovery
 * entirely, which is what an embedded caller or a test wants.
 */
export function resolveProjectConfig(override?: AlineoAgentConfig): AlineoAgentConfig {
  if (override) return override;

  const cwd = process.cwd();
  const cached = cache.get(cwd);
  if (cached) return cached;

  const config = loadProjectConfig({ cwd });
  cache.set(cwd, config);
  return config;
}

/**
 * Read `alineo.config.json`, merged with built-in defaults.
 *
 * Kept `async` because every caller already awaits it; the read itself is synchronous and
 * cached.
 */
export async function readProjectConfig(): Promise<AlineoAgentConfig> {
  return resolveProjectConfig();
}

/** Drop cached configs. For tests that change the working directory or the file on disk. */
export function clearProjectConfigCache(): void {
  cache.clear();
}
