import type { BrowserOptions } from "./commands";
import { nodeCommand, nodeEnvCommand } from "./serialize";
import {
  filterState,
  sessionRequest,
  type FileRef,
  type SessionRequestConfig,
} from "./scripts/node-scripts";

export type { FileRef };

/** Exec options the session helpers pass through (a subset of `WorkflowExecOptions`). */
export interface SessionExecOptions {
  name?: string;
  env?: Record<string, string>;
  as?: string;
  parse?: "text" | "json";
  strict?: boolean;
}

/**
 * The parts of `@alineo-labs/workflow`'s `SandboxBuilder` these helpers queue ops on. A
 * structural type, so this package needs no dependency on the workflow package.
 */
export interface SessionBuilder {
  exec(cmd: string, opts?: SessionExecOptions): unknown;
  readFileBytes(path: string, as: string): unknown;
  writeFileBytes(path: string, bytes: Uint8Array): unknown;
  deleteFile(path: string): unknown;
}

/** Options for `b.session.save` and `b.session.load`. */
export interface SessionFileOptions {
  /** Where the state file sits inside the sandbox while it is in use. */
  path?: string;
}

/** Options for `b.session.save`. */
export interface SessionSaveOptions extends SessionFileOptions {
  /**
   * Keep only cookies and storage for these domains (subdomains included). A browser also
   * collects cookies from sites it talks to in the background; this drops them.
   */
  domains?: string[];
}

/** Options for `saveSession`/`loadSession` (deprecated). */
export interface SessionOptions extends Pick<BrowserOptions, "session"> {
  path?: string;
}

/** A request for `b.session.request`. Values in `query`, `json` and `form` may be `ref(...)`s. */
export interface SessionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  /** Storage-state file in the sandbox. Default: the path `b.session.dump()` writes. */
  session?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, unknown>;
  /** Write the response body to this sandbox path. A later request can `ref()` it if it is JSON. */
  out?: string;
  /** Header values from saved localStorage: `{ authorization: { origin, key, prefix? } }`. */
  headerFromStorage?: Record<string, { origin: string; key: string }>;
  /** Checks on the response. A failed check is not a success. */
  expect?: { contentType?: RegExp | string; magic?: string; minSize?: number };
  /** JSON paths to return in `data.picked`, e.g. `{ ids: "data[].id" }`. They reach the host. */
  pick?: Record<string, string>;
  /** Return the whole JSON body in `data.body`. It reaches the host. Default `false`. */
  returnBody?: boolean;
  /** Delete the session file when the request finishes. */
  deleteSession?: boolean;
  timeoutMs?: number;
}

/** A value read inside the sandbox from a JSON file a previous request wrote with `out`. */
export function ref(file: string, path: string): FileRef {
  return { $ref: { file, path } };
}

const DEFAULT_STATE_PATH = "/tmp/alineo-browser-state.json";

export function sessionApi(
  commands: {
    open(url: string): string;
    stateSave(p: string): string;
    stateLoad(p: string): string;
  },
  opts: BrowserOptions,
) {
  const dump = (path: string = DEFAULT_STATE_PATH): string => commands.stateSave(path);
  return {
    /** The default sandbox path `dump`, `save`, `load` and `request` use. */
    defaultPath: DEFAULT_STATE_PATH,

    /**
     * Command: write the running browser's cookies and storage to `path` inside the sandbox.
     * Nothing leaves the sandbox. The file is a live credential while it exists.
     */
    dump,

    /**
     * Queue: dump the session, optionally keep only `domains`, read the file into `vars[as]`
     * as bytes, then delete it. For storing a session between runs: encrypt the bytes.
     */
    save(sb: SessionBuilder, as: string, o: SessionSaveOptions = {}): void {
      const path = o.path ?? DEFAULT_STATE_PATH;
      sb.exec(dump(path), { name: "browser.session.save" });
      if (o.domains) {
        sb.exec(nodeCommand(filterState, { path, domains: o.domains }), {
          name: "browser.session.filter",
        });
      }
      sb.readFileBytes(path, as);
      sb.deleteFile(path);
    },

    /**
     * Queue: write saved session bytes, start the browser on `about:blank`, load the state into
     * it, then delete the file. Open the site after this.
     */
    load(sb: SessionBuilder, bytes: Uint8Array, o: SessionFileOptions = {}): void {
      const path = o.path ?? DEFAULT_STATE_PATH;
      sb.writeFileBytes(path, bytes);
      sb.exec(commands.open("about:blank"), { name: "browser.open" });
      sb.exec(commands.stateLoad(path), { name: "browser.session.load" });
      sb.deleteFile(path);
    },

    /**
     * Queue: call a site's API with the cookies in a session file, from inside the sandbox
     * (same IP, egress rules and cookies as the browser). Needs no running browser: use it after
     * `dump()`, or after `writeFileBytes` of stored session bytes.
     *
     * Prints an agent-browser-style envelope: `{ success, data: { status, contentType, size,
     * url, picked? }, error, code? }`. `code` is `auth_expired` for 401/403, an HTML page where
     * `expect.contentType` wanted something else, or a redirect to another site. The process
     * exits 1 on failure, so the step fails unless `strict: false`.
     *
     * The request config travels in an env var, not in the command text the ledger records.
     */
    request(sb: SessionBuilder, req: SessionRequest, execOpts: SessionExecOptions = {}): void {
      const cfg: SessionRequestConfig = {
        session: req.session ?? DEFAULT_STATE_PATH,
        method: req.method,
        url: req.url,
        query: req.query,
        headers: req.headers,
        json: req.json,
        form: req.form,
        out: req.out,
        headerFromStorage: req.headerFromStorage
          ? Object.fromEntries(
              Object.entries(req.headerFromStorage).map(([h, s]) => [h, `${s.origin}|${s.key}`]),
            )
          : undefined,
        expect: req.expect
          ? {
              contentType:
                req.expect.contentType instanceof RegExp
                  ? req.expect.contentType.source
                  : req.expect.contentType,
              magic: req.expect.magic,
              minSize: req.expect.minSize,
            }
          : undefined,
        pick: req.pick,
        returnBody: req.returnBody,
        userAgent: opts.userAgent,
        deleteSession: req.deleteSession,
        timeoutMs: req.timeoutMs,
      };
      sb.exec(nodeEnvCommand(sessionRequest, "AB_SESSION_REQUEST"), {
        name: "browser.session.request",
        parse: "json",
        ...execOpts,
        env: { ...execOpts.env, AB_SESSION_REQUEST: JSON.stringify(cfg) },
      });
    },
  };
}

/** @deprecated Use `browser().session.save(sb, as, opts)`. */
export function saveSession(sb: SessionBuilder, as: string, opts: SessionOptions = {}): void {
  const path = opts.path ?? DEFAULT_STATE_PATH;
  const prefix =
    opts.session === undefined
      ? "agent-browser --json"
      : `agent-browser --json --session '${opts.session.replaceAll("'", "'\\''")}'`;
  sb.exec(`${prefix} state save '${path}'`, { name: "browser.session.save" });
  sb.readFileBytes(path, as);
  sb.deleteFile(path);
}

/** @deprecated Use `browser().session.load(sb, bytes, opts)`. */
export function loadSession(
  sb: SessionBuilder,
  bytes: Uint8Array,
  opts: SessionOptions = {},
): void {
  const path = opts.path ?? DEFAULT_STATE_PATH;
  const prefix =
    opts.session === undefined
      ? "agent-browser --json"
      : `agent-browser --json --session '${opts.session.replaceAll("'", "'\\''")}'`;
  sb.writeFileBytes(path, bytes);
  sb.exec(`${prefix} open 'about:blank'`, { name: "browser.open" });
  sb.exec(`${prefix} state load '${path}'`, { name: "browser.session.load" });
  sb.deleteFile(path);
}
