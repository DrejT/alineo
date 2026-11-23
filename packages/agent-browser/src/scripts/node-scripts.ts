/**
 * Scripts that run inside the sandbox under node (serialized by the helpers in `../session.ts`
 * and `../har.ts`). Each must be self-contained: no references outside its own body. They are
 * exported so the unit tests can call them directly.
 */

import type * as NodeFs from "node:fs";

export interface HarSummaryConfig {
  path: string;
  /** Registrable domains that count as first-party, e.g. ["example.com"]. */
  firstParty: string[];
  mask: boolean;
}

export function harSummary(cfg: HarSummaryConfig, fs: typeof NodeFs): string {
  const ID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b[A-Z]{2,}[0-9]{4,}\b/gi;
  const maskPath = (p: string): string =>
    cfg.mask
      ? p
          .split("/")
          .map((s) => s.replace(ID_RE, "<id>").replace(/\d{3,}/g, "<n>"))
          .join("/")
      : p;
  const isFirst = (host: string): boolean =>
    cfg.firstParty.some((d) => host === d || host.endsWith(`.${d}`));
  const keysOf = (v: unknown, prefix = ""): string[] => {
    if (Array.isArray(v)) {
      const first = v.find((x) => x && typeof x === "object");
      return first ? keysOf(first, `${prefix}[].`) : [prefix.replace(/\.$/, "") + "[]"];
    }
    if (v && typeof v === "object") {
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
        x && typeof x === "object" ? keysOf(x, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    }
    return [prefix.replace(/\.$/, "")];
  };
  type Entry = {
    request: {
      method: string;
      url: string;
      headers: Array<{ name: string }>;
      postData?: { text?: string; mimeType?: string };
    };
    response: { status: number; content?: { mimeType?: string; size?: number } };
  };
  const har = JSON.parse(fs.readFileSync(cfg.path, "utf8")) as { log: { entries: Entry[] } };
  const rows = [];
  for (const e of har.log.entries) {
    const u = new URL(e.request.url);
    if (!isFirst(u.hostname)) continue;
    const mime = e.response.content?.mimeType ?? "";
    if (/^(image|font|video|audio)\//.test(mime) || /css|javascript|wasm/.test(mime)) continue;
    if (/\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(u.pathname)) continue;
    let body: unknown;
    const text = e.request.postData?.text;
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = Object.fromEntries(new URLSearchParams(text));
      }
      body = cfg.mask ? keysOf(parsed) : parsed;
    }
    rows.push({
      method: e.request.method,
      host: u.hostname,
      path: maskPath(u.pathname),
      query: cfg.mask ? [...new Set(u.searchParams.keys())] : Object.fromEntries(u.searchParams),
      body,
      status: e.response.status,
      contentType: mime,
      size: e.response.content?.size,
      authHeaders: e.request.headers
        .map((h) => h.name.toLowerCase())
        .filter((n) =>
          /^(authorization|x-[a-z0-9-]*(csrf|xsrf|token|auth|sig|signature|nonce)[a-z0-9-]*)$/.test(
            n,
          ),
        ),
    });
  }
  return JSON.stringify({ success: true, data: { requests: rows }, error: null });
}

export interface FilterStateConfig {
  path: string;
  /** Keep cookies and origins for these domains (and their subdomains). */
  domains: string[];
}

export function filterState(cfg: FilterStateConfig, fs: typeof NodeFs): string {
  const match = (host: string): boolean => {
    const h = host.replace(/^\./, "");
    return cfg.domains.some((d) => h === d || h.endsWith(`.${d}`));
  };
  const state = JSON.parse(fs.readFileSync(cfg.path, "utf8")) as {
    cookies?: Array<{ domain: string }>;
    origins?: Array<{ origin: string }>;
  };
  const before = state.cookies?.length ?? 0;
  state.cookies = (state.cookies ?? []).filter((c) => match(c.domain));
  state.origins = (state.origins ?? []).filter((o) => {
    try {
      return match(new URL(o.origin).hostname);
    } catch {
      return false;
    }
  });
  fs.writeFileSync(cfg.path, JSON.stringify(state, null, 2), { mode: 0o600 });
  return JSON.stringify({
    success: true,
    data: { cookies: state.cookies.length, dropped: before - state.cookies.length },
    error: null,
  });
}

/** A value read from a JSON file in the sandbox, at a path like `data.items[].id`. */
export interface FileRef {
  $ref: { file: string; path: string };
}

export interface SessionRequestConfig {
  /** Storage-state file written by `b.session.dump()` or `writeFileBytes`. */
  session: string;
  method: string;
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, unknown>;
  /** Write the response body here (bytes). */
  out?: string;
  /** Read a header value from saved localStorage: `{ authorization: "https://app.example.com|token" }`. */
  headerFromStorage?: Record<string, string>;
  expect?: { contentType?: string; magic?: string; minSize?: number };
  /** JSON paths to return from a JSON response, e.g. `{ ids: "data[].id" }`. */
  pick?: Record<string, string>;
  userAgent?: string;
  deleteSession?: boolean;
  timeoutMs?: number;
  /** Return the full JSON body in `data.body` (no `out`). Off by default. */
  returnBody?: boolean;
}

export async function sessionRequest(
  cfg: SessionRequestConfig,
  fs: typeof NodeFs,
): Promise<string> {
  const fail = (code: string, error: string, data: unknown = null): string =>
    JSON.stringify({ success: false, data, error, code });
  const getPath = (obj: unknown, path: string): unknown => {
    let cur: unknown[] = [obj];
    for (const raw of path.split(".").filter(Boolean)) {
      const flat = raw.endsWith("[]");
      const key = flat ? raw.slice(0, -2) : raw;
      cur = cur.flatMap((v) => {
        const x =
          key && v && typeof v === "object"
            ? (v as Record<string, unknown>)[key]
            : key
              ? undefined
              : v;
        return flat ? (Array.isArray(x) ? x : []) : [x];
      });
    }
    return path.includes("[]") ? cur : cur[0];
  };
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") {
      const ref = (v as Partial<FileRef>).$ref;
      if (ref && typeof ref.file === "string" && typeof ref.path === "string") {
        return getPath(JSON.parse(fs.readFileSync(ref.file, "utf8")), ref.path);
      }
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolve(x)]),
      );
    }
    return v;
  };
  const site = (host: string): string => host.split(".").slice(-2).join(".");

  type Cookie = {
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    expires?: number;
  };
  type State = {
    cookies?: Cookie[];
    origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
  };
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(cfg.session, "utf8")) as State;
  } catch {
    return fail("no_session", `cannot read session file ${cfg.session}`);
  }
  const now = Date.now() / 1000;
  const cookieHeader = (u: URL): string =>
    (state.cookies ?? [])
      .filter((c) => {
        const d = c.domain.replace(/^\./, "");
        const domainOk = c.domain.startsWith(".")
          ? u.hostname === d || u.hostname.endsWith(`.${d}`)
          : u.hostname === d;
        const p = c.path ?? "/";
        const pathOk =
          u.pathname === p || u.pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || p === "/";
        const secureOk = !c.secure || u.protocol === "https:";
        const live = !c.expires || c.expires <= 0 || c.expires > now;
        return domainOk && pathOk && secureOk && live;
      })
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

  try {
    const url = new URL(cfg.url);
    for (const [k, raw] of Object.entries(resolve(cfg.query ?? {}) as Record<string, unknown>)) {
      for (const v of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(k, String(v));
    }
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (cfg.userAgent) headers["user-agent"] = cfg.userAgent;
    for (const [h, ref] of Object.entries(cfg.headerFromStorage ?? {})) {
      const [origin, key] = ref.split("|");
      const item = state.origins
        ?.find((o) => o.origin === origin)
        ?.localStorage?.find((i) => i.name === key);
      if (!item) return fail("no_session", `no localStorage ${key} for ${origin}`);
      headers[h] = item.value;
    }
    let body: string | undefined;
    if (cfg.json !== undefined) {
      body = JSON.stringify(resolve(cfg.json));
      headers["content-type"] ??= "application/json";
    } else if (cfg.form) {
      const f = new URLSearchParams();
      for (const [k, raw] of Object.entries(resolve(cfg.form) as Record<string, unknown>)) {
        for (const v of Array.isArray(raw) ? raw : [raw]) f.append(k, String(v));
      }
      body = f.toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    }

    // Follow redirects by hand, so each hop gets its own cookies, and a jump to another site
    // (a login page) is reported instead of followed.
    let target = url;
    let method = cfg.method.toUpperCase();
    let res: Response | undefined;
    for (let hop = 0; hop < 6; hop++) {
      const cookie = cookieHeader(target);
      res = await fetch(target, {
        method,
        headers: cookie ? { ...headers, cookie } : headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, target);
      if (site(next.hostname) !== site(url.hostname)) {
        return fail("auth_expired", `redirected to another site (${next.hostname})`, {
          status: res.status,
        });
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      target = next;
    }
    if (!res) return fail("request_failed", "no response");
    const contentType = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const meta = {
      status: res.status,
      contentType,
      size: bytes.length,
      url: target.host + target.pathname,
    };
    if (res.status === 401 || res.status === 403)
      return fail("auth_expired", `HTTP ${res.status}`, meta);
    if (res.status >= 400) return fail("http_error", `HTTP ${res.status}`, meta);
    const e = cfg.expect ?? {};
    if (e.contentType && !new RegExp(e.contentType, "i").test(contentType)) {
      return /text\/html/i.test(contentType)
        ? fail("auth_expired", "got an HTML page instead of the expected content", meta)
        : fail("unexpected_content", `content type ${contentType}`, meta);
    }
    if (e.minSize !== undefined && bytes.length < e.minSize)
      return fail("unexpected_content", `only ${bytes.length} bytes`, meta);
    if (e.magic) {
      const head = Buffer.from(bytes.slice(0, e.magic.length)).toString("latin1");
      if (head !== e.magic)
        return fail("unexpected_content", "file does not start with the expected bytes", meta);
    }
    if (cfg.out) fs.writeFileSync(cfg.out, bytes, { mode: 0o600 });
    let picked: Record<string, unknown> | undefined;
    let parsed: unknown;
    if ((cfg.pick || cfg.returnBody) && /json/i.test(contentType)) {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (cfg.pick)
        picked = Object.fromEntries(
          Object.entries(cfg.pick).map(([k, p]) => [k, getPath(parsed, p)]),
        );
    }
    return JSON.stringify({
      success: true,
      data: { ...meta, picked, body: cfg.returnBody ? parsed : undefined },
      error: null,
    });
  } catch (err) {
    return fail("request_failed", err instanceof Error ? err.message : String(err));
  } finally {
    if (cfg.deleteSession) {
      try {
        fs.unlinkSync(cfg.session);
      } catch {
        // already gone
      }
    }
  }
}
