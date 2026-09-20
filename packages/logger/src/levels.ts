import type { LevelName, LevelSetting } from "./types";

const RANK: Record<LevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function isLevelSetting(value: unknown): value is LevelSetting {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

/** Case-insensitive; `undefined` when the text is not a level. */
export function parseLevel(text: string): LevelSetting | undefined {
  const normalized = text.trim().toLowerCase();
  return isLevelSetting(normalized) ? normalized : undefined;
}

/** True when a record at `level` passes `threshold`. */
export function meets(level: LevelName, threshold: LevelSetting): boolean {
  return RANK[level] >= RANK[threshold];
}
