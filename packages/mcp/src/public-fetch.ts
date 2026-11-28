/**
 * Fetch JSON from a URL the caller chose, without letting the caller aim the server at its own
 * network. `spec_add` in remote mode takes a URL from a stranger. Without this, that URL could be
 * `http://127.0.0.1:8080` (OpenSandbox), a cloud metadata address, or any host on the private
 * network the server runs in.
 *
 * Rules: `https` only, port 443 only, no credentials in the URL, every address the name resolves
 * to must be a public one, redirects are followed by hand and each hop is checked again, the
 * body is capped, and the whole request has a timeout.
 *
 * Known limit: the name is resolved here and again by `fetch`. A hostile DNS server can answer
 * differently the second time (DNS rebinding). Closing that needs a pinned connection, which
 * `fetch` does not offer. Run the server where it cannot reach private addresses as well.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolve = (hostname: string) => Promise<string[]>;

const defaultResolve: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

export class PublicFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFetchError";
  }
}

function inV4(octets: number[], base: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 4 && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((octets[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

const BLOCKED_V4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, including cloud metadata
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, including broadcast
];

function parseV4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** Eight 16-bit groups, or `null` when the text is not an IPv6 address. */
function parseV6(input: string): number[] | null {
  let text = input.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const high = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const low = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const fill =
    halves.length === 2 ? new Array<string>(8 - head.length - rest.length).fill("0") : [];
  const groups = [...head, ...fill, ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return groups.length === 8 && groups.every((n) => !Number.isNaN(n)) ? groups : null;
}

/** True only for an address on the public internet. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4) return !BLOCKED_V4.some(([base, bits]) => inV4(v4, base, bits));
  const g = parseV6(address);
  if (!g) return false;
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothes. Judge the IPv4 part.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return isPublicAddress(
      `${(g[6] ?? 0) >> 8}.${(g[6] ?? 0) & 0xff}.${(g[7] ?? 0) >> 8}.${(g[7] ?? 0) & 0xff}`,
    );
  }
  const first = g[0] ?? 0;
  if (first < 0x2000 || first > 0x3fff) return false; // not global unicast (2000::/3)
  if (first === 0x2001 && ((g[1] ?? 0) === 0 || (g[1] ?? 0) === 0xdb8)) return false; // Teredo, documentation
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 address
  return true;
}

export interface PublicFetchOptions {
  /** Largest body to read, in bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Whole-request budget in ms. Default 10 000. */
  timeoutMs?: number;
  /** Redirects to follow, each one checked again. Default 3. */
  maxRedirects?: number;
  /** Name lookup. Tests pass a fake one. */
  resolve?: Resolve;
  fetchImpl?: typeof fetch;
}

async function assertPublicUrl(url: URL, resolve: Resolve): Promise<void> {
  if (url.protocol !== "https:") throw new PublicFetchError("only https:// URLs are allowed");
  if (url.username || url.password) throw new PublicFetchError("a URL may not carry credentials");
  if (url.port !== "" && url.port !== "443") throw new PublicFetchError("only port 443 is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".internal")) {
    throw new PublicFetchError(`host ${host} is not public`);
  }
  const addresses = isIP(host) !== 0 ? [host] : await resolve(host);
  if (addresses.length === 0) throw new PublicFetchError(`host ${host} did not resolve`);
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new PublicFetchError(`host ${host} is not public`);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new PublicFetchError(`response is larger than ${maxBytes} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PublicFetchError(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GET `url` and parse the body as JSON, under the rules in this file's header. */
export async function fetchPublicJson(
  url: string,
  options: PublicFetchOptions = {},
): Promise<unknown> {
  const {
    maxBytes = 1024 * 1024,
    timeoutMs = 10_000,
    maxRedirects = 3,
    resolve = defaultResolve,
    fetchImpl = fetch,
  } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new PublicFetchError("not a valid URL");
  }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, resolve);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      if (err instanceof PublicFetchError) throw err;
      throw new PublicFetchError(`could not fetch ${current.origin}${current.pathname}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new PublicFetchError(`redirect with no location (${res.status})`);
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new PublicFetchError(`fetch failed: ${res.status} ${res.statusText}`);
    const text = await readCapped(res, maxBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PublicFetchError("the response is not JSON");
    }
  }
  throw new PublicFetchError(`more than ${maxRedirects} redirects`);
}
