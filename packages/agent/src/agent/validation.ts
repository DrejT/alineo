import type { AgentSpec } from "../schema";

/**
 * The durable resource identity for a spawned child, frozen from the child spec BEFORE
 * `Alineo.spawn()` overwrites its `.name` to the forked sandbox's auto-generated ledger name
 * (`fork-<parent>-<id>`) — see `AgentSpec.resourceId`'s own doc comment for why `child.name`
 * can't be read for this after the fork completes. Extracted as its own function (mirroring
 * `resolveParentSpawnDepth`/`resolveParentMaxAgents` below) so this one line of resolution
 * logic — easy to get backwards, hard to notice if so, since both `spawnChild()`'s
 * `self.sandbox.fork()` call and its returned `AgentConstructorArgs.spec.resourceId` must
 * agree on the exact same value — is independently unit-testable.
 */
export function resolveChildResourceId(childSpec: Pick<AgentSpec, "name" | "resourceId">): string {
  return childSpec.resourceId ?? childSpec.name;
}

export function assertValidSpawnDepth(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${context}: spawnDepth must be a non-negative integer (got ${value})`);
  }
}

export function assertValidMaxAgents(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${context}: maxAgents must be a non-negative integer (got ${value})`);
  }
}

/**
 * Resolves and validates the spawn-depth budget available to `Alineo.spawn()` —
 * `override` (a `--depth` CLI flag) wins if given, else whatever value was
 * materialised into `ALINEO_SPAWN_DEPTH` by `Alineo.load()`/`Alineo.resume()`. Throws
 * unless the result is a positive integer: `0` means "no budget left", not "spawn
 * one more time" — spawning stops one level before the counter would go negative.
 */
export function resolveParentSpawnDepth(envValue: string | undefined, override?: number): number {
  const raw = override ?? (envValue !== undefined ? Number(envValue) : undefined);
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `Alineo.spawn() refused: spawn depth must be a positive integer (got ${envValue ?? "unset"}). ` +
        `Set "spawnDepth" in this agent's spec, or pass { spawnDepth } explicitly.`,
    );
  }
  return raw;
}

/**
 * Resolves the max-agents budget for `Alineo.spawn()` — same tamper-resistant
 * env-counter shape as `resolveParentSpawnDepth`, but optional: `undefined`
 * means "no cap enforced for this dimension," not "spawning refused."
 * `spawnDepth` alone still gates whether spawning is allowed at all; this is
 * an independent, additive ceiling on total descendants for THIS lineage —
 * sibling branches spawned in parallel don't share this budget.
 */
export function resolveParentMaxAgents(
  envValue: string | undefined,
  override?: number,
): number | undefined {
  const raw = override ?? (envValue !== undefined ? Number(envValue) : undefined);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `Alineo.spawn() refused: maxAgents must be a non-negative integer (got ${raw}).`,
    );
  }
  return raw;
}
