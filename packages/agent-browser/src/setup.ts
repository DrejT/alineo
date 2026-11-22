/** Local copy of `alineo`'s `SetupStep` shape — avoids a cross-package dependency for a
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
 * The agent-browser release `browserSetupSteps()` installs by default: the last one verified
 * end to end against an OpenSandbox sandbox (`tests/integration/workflow-browser-session.test.ts`).
 * Move it only after that test passes on the new release. An unpinned install picks up whatever
 * is newest, and a new release has already changed how `install --with-deps` behaves once.
 */
export const AGENT_BROWSER_VERSION = "0.43.0";

/** Options for `browserSetupSteps()`. */
export interface BrowserSetupOptions {
  /** agent-browser version to install. Default: `AGENT_BROWSER_VERSION`. */
  version?: string;
}

/**
 * Setup steps that make agent-browser usable inside a alineo sandbox: Chrome's system
 * dependencies, agent-browser itself, then the Chrome binary. Any spec whose agent will use the
 * `browser_*` tools (see `pi-extension/agent-browser.ts`), or any workflow that drives the
 * browser, runs these first — e.g. `setup: [...otherSteps, ...browserSetupSteps()]`.
 *
 * One step, three legs. `apt-get` (Chrome's system libraries) and `npm install -g agent-browser`
 * run in parallel: npm does not touch dpkg, so they cannot conflict. `agent-browser install`
 * (the Chrome download) runs after both.
 *
 * `agent-browser install` must not run in parallel with `apt-get`, and must not get
 * `--with-deps`. Current agent-browser runs `apt-get` itself for `--with-deps`, as root with no
 * `sudo`. Next to our own `apt-get`, the two fight for the dpkg lock and one fails with
 * `Could not get lock /var/lib/dpkg/lock-frontend` (seen live, 2026-11-23). Older releases went
 * through `sudo`, which does not exist in an OpenSandbox container, so that leg failed silently.
 * That is why this package installs the library list itself.
 */
export function browserSetupSteps(opts: BrowserSetupOptions = {}): SetupStep[] {
  const version = opts.version ?? AGENT_BROWSER_VERSION;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`browserSetupSteps: invalid agent-browser version ${JSON.stringify(version)}`);
  }
  return [
    {
      name: `Install Chrome's system dependencies and agent-browser@${version} in parallel, then download Chrome`,
      run:
        `(apt-get update && apt-get install -y ${CHROME_APT_PACKAGES}) &\n` +
        `apt_pid=$!\n` +
        `npm install -g agent-browser@${version} &\n` +
        `npm_pid=$!\n` +
        `wait "$apt_pid"; apt_status=$?\n` +
        `wait "$npm_pid"; npm_status=$?\n` +
        `if [ "$apt_status" -ne 0 ] || [ "$npm_status" -ne 0 ]; then\n` +
        `  echo "apt-get exited $apt_status, npm install exited $npm_status" >&2\n` +
        `  exit 1\n` +
        `fi\n` +
        `agent-browser install`,
    },
  ];
}
