/**
 * Hand a workflow's browser to a person for one step, then take it back.
 *
 * Some steps must be done by a person: a captcha, a one-time code, a "confirm on your phone"
 * screen. `handover` queues three steps on a `SandboxBuilder`:
 *
 * 1. `<name>: live view`: start agent-browser's stream and give the caller a
 *    `BrowserStreamInfo` through `onLive`. The caller relays it to the person
 *    (`relayBrowserStream`).
 * 2. `<name>: wait`: wait until the page reaches `until`, for at most `timeoutMs`.
 * 3. `<name>: end live view`: stop the stream and call `onEnd`.
 *
 * If the person does not finish in time, step 2 fails and the workflow fails with it.
 */
import type { WaitOptions } from "./commands";
import {
  disableBrowserStream,
  enableBrowserStream,
  type BrowserStreamInfo,
  type StreamSandbox,
} from "./stream";

/** The parts of `SandboxBuilder` that `handover` uses. */
export interface HandoverBuilder {
  exec(cmd: string, opts?: { name?: string; timeoutMs?: number }): unknown;
  host(name: string, fn: (sandbox: StreamSandbox) => void | Promise<void>): unknown;
}

/** The wait commands of `browser()` that `handover` uses. */
export interface HandoverCommands {
  waitForUrl(pattern: string, w?: WaitOptions): string;
  waitForSelector(selector: string, w?: WaitOptions): string;
  waitForText(text: string, w?: WaitOptions): string;
}

/** When the person is done: a URL glob, an element, or text on the page. */
export type HandoverUntil = { url: string } | { selector: string } | { text: string };

export interface HandoverOptions {
  /** Step name prefix in `onEvent`. Default `"handover"`. */
  name?: string;
  /** The page state that means the person is done. */
  until: HandoverUntil;
  /** How long the person has, in milliseconds. */
  timeoutMs: number;
  /**
   * Called once the live view is up. `stream.headers` grant access to the sandbox's port
   * proxy: keep them on the server, and never send them to a browser tab or a log.
   */
  onLive: (stream: BrowserStreamInfo) => void | Promise<void>;
  /** Called after the person is done and the stream is stopped. Not called on timeout. */
  onEnd?: () => void | Promise<void>;
  /** agent-browser session name, if the workflow's `browser()` uses one. */
  session?: string;
}

/** Extra time for the exec around agent-browser's own wait timeout. */
const EXEC_MARGIN_MS = 30_000;

/** Queue a handover. See the module comment. */
export function handover(sb: HandoverBuilder, b: HandoverCommands, o: HandoverOptions): void {
  const name = o.name ?? "handover";
  const w = { timeoutMs: o.timeoutMs };
  const wait =
    "url" in o.until
      ? b.waitForUrl(o.until.url, w)
      : "selector" in o.until
        ? b.waitForSelector(o.until.selector, w)
        : b.waitForText(o.until.text, w);

  sb.host(`${name}: live view`, async (sandbox) => {
    await o.onLive(await enableBrowserStream(sandbox, { session: o.session }));
  });
  sb.exec(wait, { name: `${name}: wait`, timeoutMs: o.timeoutMs + EXEC_MARGIN_MS });
  sb.host(`${name}: end live view`, async (sandbox) => {
    await disableBrowserStream(sandbox, { session: o.session });
    await o.onEnd?.();
  });
}
