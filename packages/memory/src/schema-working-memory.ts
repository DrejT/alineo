import type { ResourceRef } from "./types";
import type { IWorkingMemoryProvider } from "./working";

/**
 * Minimal shape every popular schema library already satisfies (`ZodSchema.parse`,
 * `valibot`'s `parse()` wrapper, a hand-rolled validator) — duck-typed the same way
 * `EmbeddingProvider` is, so this package never depends on a concrete schema library. Throws
 * on invalid input; the exact error type is whatever the underlying library throws.
 */
export interface SchemaValidator<T> {
  parse(data: unknown): T;
}

/**
 * A typed, validated profile stored as one working-memory record — the structured
 * counterpart to `IWorkingMemoryProvider`'s raw untyped key/value pairs. Useful for the
 * common "agent maintains a structured user profile" shape (name, preferences, goals) where
 * raw key/value gives no guarantee about what's actually stored.
 *
 * Validation only fires on `update()`, not on `get()` — a profile written by an older schema
 * version should still be readable (as `Partial<T>`, since it may be missing fields a newer
 * schema requires) rather than throwing on every read after a schema change.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { SchemaWorkingMemory } from "@alineo-labs/memory";
 *
 * const ProfileSchema = z.object({
 *   name: z.string().optional(),
 *   preferredLanguage: z.string().optional(),
 * });
 *
 * const profile = new SchemaWorkingMemory(workingMemoryProvider, ProfileSchema);
 * await profile.update(ref, { preferredLanguage: "TypeScript" });
 * await profile.get(ref); // { preferredLanguage: "TypeScript" }
 * ```
 *
 * Pass a schema that already tolerates partial input (e.g. Zod's own `.partial()`) if
 * `update()` should succeed before every field has been filled in — this class imposes no
 * partial/full policy of its own, it only merges and validates with whatever `schema` given.
 */
export class SchemaWorkingMemory<T extends Record<string, unknown>> {
  constructor(
    private readonly provider: IWorkingMemoryProvider,
    private readonly schema: SchemaValidator<T>,
    /** Working-memory key the whole profile is stored under. */
    private readonly key: string = "__profile",
  ) {}

  /** The stored profile, or `{}` if nothing has been set yet. Not re-validated on read. */
  async get(ref: ResourceRef): Promise<Partial<T>> {
    const raw = await this.provider.get(ref, this.key);
    return (raw ?? {}) as Partial<T>;
  }

  /**
   * Shallow-merge `patch` into the current profile, validate the result against `schema`, and
   * persist it. Returns the validated (and possibly schema-transformed, e.g. defaults filled
   * in) profile.
   * @throws whatever `schema.parse()` throws if the merged object is invalid.
   */
  async update(ref: ResourceRef, patch: Partial<T>): Promise<T> {
    const current = await this.get(ref);
    const merged = { ...current, ...patch };
    const validated = this.schema.parse(merged);
    await this.provider.set(ref, this.key, validated);
    return validated;
  }

  /** Remove the whole profile. */
  async clear(ref: ResourceRef): Promise<void> {
    await this.provider.delete(ref, this.key);
  }
}
