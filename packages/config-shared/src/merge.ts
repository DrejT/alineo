/** A plain JSON object — the only thing `mergeDeep` recurses into. */
type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Merge config sources, lowest precedence first. Plain objects merge key by key; everything
 * else (arrays, strings, numbers) is replaced wholesale by the later source.
 *
 * `undefined` never overwrites — an absent key in a higher-precedence source leaves the lower
 * one intact, which is what makes "env var not set" mean "don't override" rather than "clear".
 * An explicit `null` *does* overwrite, so a config file can blank a value on purpose.
 */
export function mergeDeep(...sources: readonly unknown[]): unknown {
  let result: unknown = undefined;

  for (const source of sources) {
    if (source === undefined) continue;
    if (isPlainObject(source) && isPlainObject(result)) {
      const merged: PlainObject = { ...result };
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        merged[key] = key in merged ? mergeDeep(merged[key], value) : value;
      }
      result = merged;
    } else {
      result = source;
    }
  }

  return result;
}

/**
 * Freeze an object and everything reachable from it, so a resolved config can't be mutated
 * after validation. Cycles are impossible in JSON-derived data, so no seen-set is needed.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
