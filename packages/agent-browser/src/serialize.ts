/** Base64 of a UTF-8 string, for passing scripts through `/bin/sh` without quoting issues. */
export function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * A shell command that runs `fn(arg)` under node in the sandbox and prints its string result.
 * `fn` must be self-contained (see `scripts/node-scripts.ts`); it gets `fs` as its second argument. The script is base64, so the
 * ledger records it as an opaque string; put secrets in env vars, not in `arg`.
 */
export function nodeCommand(fn: (arg: never, fs: never) => string, arg: unknown): string {
  const code = `process.stdout.write((${fn.toString()})(${JSON.stringify(arg)}, require("node:fs")) + "\\n");`;
  return `node -e "$(printf %s '${toBase64(code)}' | base64 -d)"`;
}

/**
 * Like `nodeCommand`, for an async `fn` whose config comes from the env var `envVar`, and whose
 * result is an agent-browser-style `{ success }` envelope: the process exits 1 when it is false.
 */
export function nodeEnvCommand(
  fn: (arg: never, fs: never) => Promise<string>,
  envVar: string,
): string {
  const code =
    `(${fn.toString()})(JSON.parse(process.env.${envVar}), require("node:fs")).then((r) => {` +
    `process.stdout.write(r + "\\n"); process.exitCode = JSON.parse(r).success ? 0 : 1; });`;
  return `node -e "$(printf %s '${toBase64(code)}' | base64 -d)"`;
}
