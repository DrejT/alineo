import { isBulkRememberable, isPrunable } from "./semantic";
import type {
  IBulkSemanticMemoryProvider,
  IPrunableSemanticMemoryProvider,
  ISemanticMemoryProvider,
  MemoryFact,
} from "./semantic";
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
 * Which of `ISemanticMemoryProvider`'s optional capability interfaces `withTeamAccessControlSemantic`
 * returns, computed from what the *input* provider actually implements — never the input's
 * own concrete class. That distinction is load-bearing: the previous version of this function
 * returned `T` (the caller's exact concrete provider type) via `as unknown as T`, which let
 * `T` be inferred as a class with extra methods (e.g. a `.close()` a real provider exposes but
 * neither `ISemanticMemoryProvider` nor this wrapper's returned object ever implements) —
 * calling one of those through the "typed" result would throw at runtime with no compiler
 * warning. Every branch below is a real interface the returned object literal actually
 * satisfies structurally, so no unsafe cast is needed at the call site — only internally, where
 * TypeScript can't otherwise prove a dynamically-assembled object matches a conditional type.
 */
type TeamGuardedSemanticProvider<T extends ISemanticMemoryProvider> =
  T extends IPrunableSemanticMemoryProvider & IBulkSemanticMemoryProvider
    ? IPrunableSemanticMemoryProvider & IBulkSemanticMemoryProvider
    : T extends IPrunableSemanticMemoryProvider
      ? IPrunableSemanticMemoryProvider
      : T extends IBulkSemanticMemoryProvider
        ? IBulkSemanticMemoryProvider
        : ISemanticMemoryProvider;

/**
 * Same enforcement for `ISemanticMemoryProvider`. Preserves whichever optional capabilities
 * the wrapped provider has (`IPrunableSemanticMemoryProvider`, `IBulkSemanticMemoryProvider`) —
 * `isPrunable()`/`isBulkRememberable()` still report correctly against the wrapped result, so
 * `compactSemanticMemory()` and `Memory.fork()`'s batched-embed path keep working through the
 * wrapper. See `TeamGuardedSemanticProvider` for why the return type is never just `T`.
 */
export function withTeamAccessControlSemantic<T extends ISemanticMemoryProvider>(
  provider: T,
  checker: TeamAccessChecker,
): TeamGuardedSemanticProvider<T> {
  let result: ISemanticMemoryProvider &
    Partial<IPrunableSemanticMemoryProvider> &
    Partial<IBulkSemanticMemoryProvider> = {
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
    result = {
      ...result,
      async listAll(ref: ResourceRef) {
        await assertAccess(ref, checker);
        return provider.listAll(ref);
      },
      async forget(ref: ResourceRef, ids: string[]) {
        await assertAccess(ref, checker);
        return provider.forget(ref, ids);
      },
    };
  }

  if (isBulkRememberable(provider)) {
    result = {
      ...result,
      async rememberMany(ref: ResourceRef, facts: MemoryFact[]) {
        await assertAccess(ref, checker);
        return provider.rememberMany(ref, facts);
      },
    };
  }

  return result as TeamGuardedSemanticProvider<T>;
}
