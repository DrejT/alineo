import { browser, type BrowserOptions } from "./commands";

/**
 * The parts of `@alineo-labs/workflow`'s `SandboxBuilder` these helpers queue ops on. A
 * structural type, so this package needs no dependency on the workflow package.
 */
export interface SessionBuilder {
  exec(cmd: string, opts?: { name?: string }): unknown;
  readFileBytes(path: string, as: string): unknown;
  writeFileBytes(path: string, bytes: Uint8Array): unknown;
  deleteFile(path: string): unknown;
}

/** Options for `saveSession` and `loadSession`. */
export interface SessionOptions extends Pick<BrowserOptions, "session"> {
  /** Where the state file sits inside the sandbox while it is in use. */
  path?: string;
}

const DEFAULT_STATE_PATH = "/tmp/alineo-browser-state.json";

/**
 * Queue: save the running browser's cookies and storage, read the file into `vars[as]` as
 * bytes, then delete it from the sandbox.
 *
 * The bytes are a credential. A cookie for a logged-in account can skip both the password and
 * any one-time code. Encrypt them before you store them, and keep them out of logs.
 *
 * @example
 * ```ts
 * saveSession(sb, "session");
 * // after the run: const { vars } = await ...result(); store(encrypt(vars.session))
 * ```
 */
export function saveSession(sb: SessionBuilder, as: string, opts: SessionOptions = {}): void {
  const path = opts.path ?? DEFAULT_STATE_PATH;
  const b = browser({ session: opts.session });
  sb.exec(b.stateSave(path), { name: "browser.session.save" });
  sb.readFileBytes(path, as);
  sb.deleteFile(path);
}

/**
 * Queue: write saved session bytes into the sandbox, start the browser on `about:blank`, load
 * the state into it, then delete the file. Open the site after this.
 *
 * Cookies and storage load into the running browser, so an `open` that follows is already
 * signed in, if the session is still valid. Check that with a wait on a page only a signed-in
 * user reaches, and fall back to a fresh login when the check fails.
 */
export function loadSession(
  sb: SessionBuilder,
  bytes: Uint8Array,
  opts: SessionOptions = {},
): void {
  const path = opts.path ?? DEFAULT_STATE_PATH;
  const b = browser({ session: opts.session });
  sb.writeFileBytes(path, bytes);
  sb.exec(b.open("about:blank"), { name: "browser.open" });
  sb.exec(b.stateLoad(path), { name: "browser.session.load" });
  sb.deleteFile(path);
}
