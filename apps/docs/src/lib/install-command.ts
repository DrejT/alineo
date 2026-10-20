/**
 * Which install command, if any, a copied docs code block holds. Drives the
 * `docs_install_command_copied` event (see `components/copy-tracking-pre.tsx`).
 *
 * Only the two commands a new user runs first: the CLI bootstrap and the SDK packages. Every other
 * `alineo-cli` line in the docs (`add`, `start`, `logs`, ...) is a later step, not an install.
 */
export type InstallKind = "cli_init" | "sdk_install";

const CLI_INIT = /\balineo-cli\s+init\b/;
const SDK_INSTALL =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b[^\n]*(?:@alineo-labs\/|(?<![\w@/-])alineo(?![\w-]))/;

export function installKindOf(text: string): InstallKind | null {
  if (CLI_INIT.test(text)) return "cli_init";
  if (SDK_INSTALL.test(text)) return "sdk_install";
  return null;
}
