/**
 * Classifies an error from `client.connect()` (or any other sandbox-control call) as "no live
 * container to reattach or resume into" — as opposed to a transient failure that might clear on
 * retry. Shared between `resumeAgent()`/`reattachAgent()` (M3, 3.3 — falls through to
 * restore-from-checkpoint on this) and `apps/alineod/src/engine/rehydrate.ts`'s restore ladder
 * (M3, 3.4 — same question, same answer), which previously had its own private copy covering
 * only the first case below.
 *
 * Two distinct ways a sandbox can be "gone," both confirmed against OpenSandbox's actual
 * behavior (DeepWiki, not just its higher-level docs — same discipline M1.4/M2's research used):
 *
 * 1. Truly deleted/unknown (`docker rm -f`, expired and reaped): a 404, surfaced as
 *    `<RUNTIME>::SANDBOX_NOT_FOUND` on the error's `code` or in its message.
 * 2. `Exited` after a host reboot or Docker daemon restart (durability-roadmap's former M2
 *    2.3, moved here): **not** a 404 — a `200 OK` with `state: "Terminated"`/`"Failed"`.
 *    `@alineo-labs/sandbox`'s `client.connect()` (`packages/sdks/typescript/src/client.ts`)
 *    already surfaces this as a `SandboxClientError` with `status: 409` and a message of the
 *    shape `"SandboxHandle <id> is <state> — can only connect to Running sandboxes"` — this
 *    classifier matches that message shape rather than re-deriving the state check itself, so
 *    it stays correct if `connect()`'s own wording ever changes without this file knowing.
 */
export function isSandboxGone(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.endsWith("SANDBOX_NOT_FOUND")) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  if (message.includes("SANDBOX_NOT_FOUND")) return true;
  return /is (?:Terminated|Failed) — can only connect to Running sandboxes/.test(message);
}
