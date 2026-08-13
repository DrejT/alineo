/** Local copy of `@alineo-labs/agent`'s `SetupStep` shape — avoids a cross-package dependency for a
 * trivial shared interface, same call `pack-local-package.ts` already makes. */
export interface SetupStep {
  name: string;
  run: string;
  cwd?: string;
}

const CHROME_APT_PACKAGES =
  "libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 " +
  "libxdamage1 libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 " +
  "libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 " +
  "libfontconfig1 libdbus-1-3 libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 " +
  "libatspi2.0-0 libcups2 libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk " +
  "fonts-freefont-ttf";

/**
 * Setup steps that make agent-browser's browser tools usable inside a alineo sandbox: Chrome's
 * system dependencies, then agent-browser itself. Any spec whose agent will use the
 * `browser_*` tools (see `pi-extension/agent-browser.ts`) should splice these into its own
 * `setup` array — e.g. `setup: [...otherSteps, ...browserSetupSteps()]`.
 *
 * Both legs run concurrently in a single step rather than as two sequential ones: `apt-get`
 * installing Chrome's system libraries and `agent-browser install --with-deps` downloading the
 * Chrome binary are independent network operations — the browser doesn't need its runtime libs
 * present to be downloaded, only to later be launched — so running them back-to-back as separate
 * `setup` steps (as this used to do) wastes wall time serializing two things that don't depend on
 * each other. `factory.ts` only awaits one `sb.exec()` per step, so getting real concurrency here
 * requires backgrounding both within one step's shell command, not just declaring two steps.
 */
export function browserSetupSteps(): SetupStep[] {
  return [
    {
      name: "Install Chrome's system dependencies and agent-browser concurrently (agent-browser install --with-deps shells out via sudo internally, which doesn't exist in this root-only container — it fails silently there, leaving Chrome unable to find libnspr4/libatk/etc. Installing the same package list directly, in parallel with agent-browser's own install/download, works around the sudo issue and overlaps the two slowest legs instead of running them back-to-back; verified against a live OpenSandbox sandbox)",
      run:
        `(apt-get update && apt-get install -y ${CHROME_APT_PACKAGES}) &\n` +
        `apt_pid=$!\n` +
        `(npm install -g agent-browser && agent-browser install --with-deps) &\n` +
        `browser_pid=$!\n` +
        `wait "$apt_pid"; apt_status=$?\n` +
        `wait "$browser_pid"; browser_status=$?\n` +
        `if [ "$apt_status" -ne 0 ] || [ "$browser_status" -ne 0 ]; then\n` +
        `  echo "apt-get exited $apt_status, agent-browser install exited $browser_status" >&2\n` +
        `  exit 1\n` +
        `fi`,
    },
  ];
}
