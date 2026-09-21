import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The file name every alineo project config uses. */
export const PROJECT_CONFIG_FILE = "alineo.config.json";

/**
 * Walk up from `startDir` looking for `alineo.config.json`.
 *
 * Before this existed, `packages/agent` only ever checked `process.cwd()`, so running a script
 * from a subdirectory silently fell back to built-in defaults — a wrong `serverUrl` looked
 * exactly like no config at all.
 *
 * The walk is **bounded**, which matters as much as the walk itself: an unbounded search would
 * let an unrelated `alineo.config.json` several levels up configure a run. It stops after
 * examining:
 *
 * - a directory containing `.git` (the project boundary),
 * - the user's home directory (global config is a separate, explicit source), or
 * - the filesystem root.
 *
 * The stop directory is itself checked before the walk ends, so a config file sitting next to
 * `.git` is still found.
 */
export function findProjectConfig(startDir: string = process.cwd()): string | null {
  const home = resolve(homedir());
  let dir = resolve(startDir);

  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;

    // Boundaries are checked *after* the candidate above, so `.git`-adjacent config still wins.
    if (existsSync(join(dir, ".git"))) return null;
    if (dir === home) return null;

    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/** Absolute path of the user-level config, `~/.config/alineo/config.json`. */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "alineo", "config.json");
}

/**
 * Read and JSON-parse a config file, or return `null` when it isn't there.
 * A file that exists but is malformed throws — a typo in config should be loud, not silently
 * ignored in favour of defaults.
 */
export function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }
}
