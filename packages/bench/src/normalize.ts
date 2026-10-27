/**
 * Compare verifier output ignoring line-ending style. CSV tools write CRLF by default and none of the
 * tasks specify line endings, so a strict comparison was failing correct work (4 of 12 hard-suite runs).
 * Kept in its own module because `outcome.ts` runs the whole benchmark when imported.
 */
export const normalizeOutput = (s: string) => s.replace(/\r\n/g, "\n").trim();
