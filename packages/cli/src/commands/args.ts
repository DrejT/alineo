/** Read the value following a `--flag` in argv, e.g. `flag(argv, "--prompt")`. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
