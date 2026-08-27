import { isPrunable } from "./semantic";
import type { ISemanticMemoryProvider, MemoryFact } from "./semantic";
import type { ResourceRef } from "./types";
import type { IWorkingMemoryProvider } from "./working";

export class MemoryAccessDeniedError extends Error {
  constructor(public readonly teamId: string) {
    super(`Access denied to team scope "${teamId}"`);
    this.name = "MemoryAccessDeniedError";
  }
}

/**
 * Authorization check for team-scoped memory access. Deliberately minimal — one method,
 * caller decides how "can access" is determined (a JWT claim, a database lookup, a static
 * allowlist). This package never assumes a concrete auth mechanism.
 */
export interface TeamAccessChecker {
  /** Return `true` if the current caller may access data scoped to this `teamId`. */
  canAccess(teamId: string): boolean | Promise<boolean>;
}

async function assertAccess(ref: ResourceRef, checker: TeamAccessChecker): Promise<void> {
  if (ref.teamId != null && !(await checker.canAccess(ref.teamId))) {
    throw new MemoryAccessDeniedError(ref.teamId);
  }
}

/**
 * Wrap an `IWorkingMemoryProvider` with app-layer team-scoping enforcement, checked before
 * every call. `@alineo-labs/postgres-memory` enforces `teamId` isolation at the database
 * layer via row-level security; every other provider (in-memory, `@alineo-labs/sqlite-memory`)
 * only isolates `teamId` structurally — `ResourceRef.teamId` folds into the storage key, so
 * data for one team simply doesn't collide with another's, but nothing stops a caller passing
 * the "wrong" `teamId` on purpose from reading it. This closes that gap for any backend,
 * making the enforcement guarantee backend-independent rather than something only a Postgres
 * deployment gets — and a Postgres deployment can still layer this on top of its own RLS for
 * defense-in-depth, it isn't an either/or.
 *
 * A `ResourceRef` with no `teamId` always passes through untouched — there's nothing to check
 * for an untenanted resource.
 */
export function withTeamAccessControl(
  provider: IWorkingMemoryProvider,
  checker: TeamAccessChecker,
): IWorkingMemoryProvider {
  return {
    async get(ref, key) {
      await assertAccess(ref, checker);
      return provider.get(ref, key);
    },
    async set(ref, key, value) {
      await assertAccess(ref, checker);
      return provider.set(ref, key, value);
    },
    async list(ref) {
      await assertAccess(ref, checker);
      return provider.list(ref);
    },
    async delete(ref, key) {
      await assertAccess(ref, checker);
      return provider.delete(ref, key);
    },
  };
}

/**
 * Same enforcement for `ISemanticMemoryProvider`. Preserves the optional
 * `IPrunableSemanticMemoryProvider` capability when the wrapped provider has it — `isPrunable()`
 * still reports correctly against the wrapped result, so `compactSemanticMemory()` keeps
 * working through the wrapper.
 */
export function withTeamAccessControlSemantic<T extends ISemanticMemoryProvider>(
  provider: T,
  checker: TeamAccessChecker,
): T {
  const base: ISemanticMemoryProvider = {
    async remember(ref: ResourceRef, fact: MemoryFact) {
      await assertAccess(ref, checker);
      return provider.remember(ref, fact);
    },
    async recall(ref: ResourceRef, query: string, opts?: { topK?: number }) {
      await assertAccess(ref, checker);
      return provider.recall(ref, query, opts);
    },
  };

  if (isPrunable(provider)) {
    return {
      ...base,
      async listAll(ref: ResourceRef) {
        await assertAccess(ref, checker);
        return provider.listAll(ref);
      },
      async forget(ref: ResourceRef, ids: string[]) {
        await assertAccess(ref, checker);
        return provider.forget(ref, ids);
      },
    } as unknown as T;
  }

  return base as unknown as T;
}
