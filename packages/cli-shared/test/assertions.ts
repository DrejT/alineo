/**
 * `await expect(promise).rejects.toThrow(...)` trips oxlint-tsgolint's `await-thenable` check
 * in this package (confirmed a tsgolint quirk, not a real type error — `tsc --noEmit --strict`
 * accepts the identical pattern cleanly). Mirrors `packages/mcp/test/assertions.ts`, which
 * sidesteps the same quirk there with a plain try/catch instead of touching shared lint config.
 */
export async function expectRejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected promise to reject, but it resolved.");
}
