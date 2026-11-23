import { nodeCommand } from "./serialize";
import { harSummary } from "./scripts/node-scripts";

/** Options for `b.har.summary()`. */
export interface HarSummaryOptions {
  /** Domains that count as first-party (subdomains included), e.g. `["example.com"]`. */
  firstParty: string[];
  /**
   * Default `true`: path ids become `<id>`/`<n>`, and only query parameter **names** and body
   * **keys** are printed. `false` prints the values too.
   */
  mask?: boolean;
}

export function harApi(cmd: (...parts: string[]) => string) {
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  return {
    /**
     * Start recording the page's traffic, with no response bodies (`--content none`). Start it
     * after login, so the login request is not recorded.
     */
    start: () => cmd("network", "har", "start", "--content", "none"),
    /** Stop recording and write the HAR file inside the sandbox. */
    stop: (path: string) => cmd("network", "har", "stop", q(path)),
    /**
     * A node command that summarizes a HAR inside the sandbox: per first-party, non-static
     * request, the method, path, query names, body keys, status, content type, size and the
     * names of auth-like headers. Request bodies can hold real values, so delete the HAR after.
     */
    summary: (path: string, o: HarSummaryOptions) =>
      nodeCommand(harSummary, { path, firstParty: o.firstParty, mask: o.mask !== false }),
  };
}

/** One request in a `b.har.summary()` result. */
export interface HarRequest {
  method: string;
  host: string;
  path: string;
  query: string[] | Record<string, string>;
  body?: unknown;
  status: number;
  contentType: string;
  size?: number;
  authHeaders: string[];
}
