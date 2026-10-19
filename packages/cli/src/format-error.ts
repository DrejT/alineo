/**
 * The text the CLI prints for a failure.
 *
 * An alineo error can carry a `hint`: the one sentence that says what to do next. The message
 * says what went wrong, so it is printed first and the hint on its own line after it.
 */
export function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = (err as { hint?: unknown } | null)?.hint;
  return typeof hint === "string" && hint.length > 0
    ? `Error: ${message}\nHint: ${hint}`
    : `Error: ${message}`;
}
