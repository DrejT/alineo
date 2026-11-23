import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterState, harSummary, sessionRequest } from "../src/scripts/node-scripts";
import { browser, ref } from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "ab-node-scripts-"));
const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80]);
let server: ReturnType<typeof Bun.serve>;
let base = "";
const seen: Array<{
  path: string;
  cookie: string | null;
  ua: string | null;
  auth: string | null;
  body: string;
}> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      seen.push({
        path: u.pathname + u.search,
        cookie: req.headers.get("cookie"),
        ua: req.headers.get("user-agent"),
        auth: req.headers.get("authorization"),
        body,
      });
      const signedIn = (req.headers.get("cookie") ?? "").includes("sid=good");
      if (u.pathname === "/redirect-away")
        return Response.redirect("https://login.example.org/", 302);
      if (u.pathname === "/redirect-here") return Response.redirect(`${base}/api/places`, 302);
      if (!signedIn) return new Response("no", { status: 401 });
      if (u.pathname === "/api/places")
        return Response.json({ data: [{ id: "P1" }, { id: "P2" }], total: 2 });
      if (u.pathname === "/api/download")
        return new Response(XLSX, {
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        });
      if (u.pathname === "/html")
        return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

function writeState(name: string, cookies: unknown[], origins: unknown[] = []): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ cookies, origins }));
  return p;
}
const good = { name: "sid", value: "good", domain: "127.0.0.1", path: "/" };
const run = async (cfg: Parameters<typeof sessionRequest>[0]) =>
  JSON.parse(await sessionRequest(cfg, fs)) as {
    success: boolean;
    code?: string;
    data: { status?: number; size?: number; picked?: Record<string, unknown> } | null;
  };

describe("sessionRequest", () => {
  test("sends only the cookies that match host, path, scheme and expiry", async () => {
    const session = writeState("cookies.json", [
      good,
      { name: "other", value: "x", domain: ".example.com", path: "/" },
      { name: "deep", value: "x", domain: "127.0.0.1", path: "/admin" },
      { name: "sec", value: "x", domain: "127.0.0.1", path: "/", secure: true },
      { name: "old", value: "x", domain: "127.0.0.1", path: "/", expires: 1000 },
      {
        name: "live",
        value: "y",
        domain: "127.0.0.1",
        path: "/api",
        expires: Date.now() / 1000 + 3600,
      },
    ]);
    const r = await run({ session, method: "GET", url: `${base}/api/places`, userAgent: "UA/1" });
    expect(r.success).toBe(true);
    const last = seen.at(-1)!;
    expect(last.cookie).toBe("sid=good; live=y");
    expect(last.ua).toBe("UA/1");
  });

  test("401 is auth_expired", async () => {
    const session = writeState("none.json", []);
    const r = await run({ session, method: "GET", url: `${base}/api/places` });
    expect(r).toMatchObject({ success: false, code: "auth_expired", data: { status: 401 } });
  });

  test("a redirect to another site is auth_expired and is not followed", async () => {
    const session = writeState("good1.json", [good]);
    const r = await run({ session, method: "GET", url: `${base}/redirect-away` });
    expect(r).toMatchObject({ success: false, code: "auth_expired" });
  });

  test("a same-site redirect is followed with cookies", async () => {
    const session = writeState("good2.json", [good]);
    const r = await run({ session, method: "GET", url: `${base}/redirect-here` });
    expect(r.success).toBe(true);
    expect(seen.at(-1)).toMatchObject({ path: "/api/places", cookie: "sid=good" });
  });

  test("an HTML page where a file was expected is auth_expired", async () => {
    const session = writeState("good3.json", [good]);
    const r = await run({
      session,
      method: "GET",
      url: `${base}/html`,
      expect: { contentType: "spreadsheetml" },
    });
    expect(r).toMatchObject({ success: false, code: "auth_expired" });
  });

  test("chains: write JSON, ref it into the next request, check magic bytes, write the file", async () => {
    const session = writeState("good4.json", [good]);
    const places = join(dir, "places.json");
    const out = join(dir, "report.xlsx");
    const first = await run({
      session,
      method: "POST",
      url: `${base}/api/places`,
      json: {},
      out: places,
      pick: { ids: "data[].id" },
    });
    expect(first.data?.picked).toEqual({ ids: ["P1", "P2"] });

    const second = await run({
      session,
      method: "POST",
      url: `${base}/api/download`,
      query: { from: "2026-10-01", to: "2026-10-31", ids: ref(places, "data[].id") },
      json: { pobIds: ref(places, "data[].id"), total: ref(places, "total") },
      out,
      expect: { contentType: "spreadsheetml", magic: "PK", minSize: 4 },
      deleteSession: true,
    });
    expect(second).toMatchObject({ success: true, data: { status: 200, size: XLSX.length } });
    expect(Array.from(readFileSync(out))).toEqual(Array.from(XLSX));
    const last = seen.at(-1)!;
    expect(last.path).toBe("/api/download?from=2026-10-01&to=2026-10-31&ids=P1&ids=P2");
    expect(JSON.parse(last.body)).toEqual({ pobIds: ["P1", "P2"], total: 2 });
    expect(existsSync(session)).toBe(false);
  });

  test("wrong magic bytes fail", async () => {
    const session = writeState("good5.json", [good]);
    const r = await run({
      session,
      method: "GET",
      url: `${base}/api/download`,
      expect: { magic: "%PDF" },
    });
    expect(r).toMatchObject({ success: false, code: "unexpected_content" });
  });

  test("reads a header from saved localStorage", async () => {
    const session = writeState(
      "good6.json",
      [good],
      [{ origin: base, localStorage: [{ name: "token", value: "Bearer abc" }] }],
    );
    const r = await run({
      session,
      method: "GET",
      url: `${base}/api/places`,
      headerFromStorage: { authorization: `${base}|token` },
    });
    expect(r.success).toBe(true);
    expect(seen.at(-1)?.auth).toBe("Bearer abc");
  });

  test("a missing session file is no_session", async () => {
    const r = await run({
      session: join(dir, "missing.json"),
      method: "GET",
      url: `${base}/api/places`,
    });
    expect(r).toMatchObject({ success: false, code: "no_session" });
  });

  test("the serialized command works under sh + node, with the config in env", async () => {
    const session = writeState("good7.json", [good]);
    const out = join(dir, "via-node.xlsx");
    const calls: Array<[string, { env?: Record<string, string> }]> = [];
    const sb = {
      exec: (cmd: string, opts?: { env?: Record<string, string> }) => calls.push([cmd, opts ?? {}]),
      readFileBytes: () => undefined,
      writeFileBytes: () => undefined,
      deleteFile: () => undefined,
    };
    browser({ userAgent: "UA/2" }).session.request(sb, {
      method: "GET",
      url: `${base}/api/download`,
      session,
      out,
      expect: { contentType: /spreadsheetml/, magic: "PK" },
    });
    const [cmd, opts] = calls[0]!;
    expect(cmd).not.toContain("api/download");
    // Async spawn: a sync one would block the event loop that serves the fixture.
    const p = Bun.spawn(["sh", "-c", cmd], {
      env: { ...process.env, ...opts.env },
      stdout: "pipe",
    });
    const stdout = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ success: true, data: { size: XLSX.length } });
    expect(seen.at(-1)?.ua).toBe("UA/2");
    expect(Array.from(readFileSync(out))).toEqual(Array.from(XLSX));
  }, 20_000);
});

describe("harSummary", () => {
  const har = join(dir, "x.har");
  const uuid = "c72f9e4f-94f5-4a1a-87e3-41a0aaf0f3aa";
  writeFileSync(
    har,
    JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: `https://app.example.com/api/v1/sellers/${uuid}/report/download?from=2026-10-01&to=2026-10-31`,
              headers: [{ name: "Cookie" }, { name: "X-CSRF-Token" }],
              postData: {
                text: JSON.stringify({ pobIds: ["DV00302423"], filters: { type: "order" } }),
              },
            },
            response: {
              status: 200,
              content: { mimeType: "application/vnd.ms-excel", size: 66892 },
            },
          },
          {
            request: { method: "GET", url: "https://app.example.com/static/app.js", headers: [] },
            response: { status: 200, content: { mimeType: "application/javascript" } },
          },
          {
            request: {
              method: "GET",
              url: "https://www.google-analytics.com/collect?v=1",
              headers: [],
            },
            response: { status: 200, content: { mimeType: "image/gif" } },
          },
        ],
      },
    }),
  );

  test("masked: names and keys only, ids masked, static and third-party dropped", () => {
    const out = harSummary({ path: har, firstParty: ["example.com"], mask: true }, fs);
    expect(out).not.toContain(uuid);
    expect(out).not.toContain("DV00302423");
    expect(out).not.toContain("2026-10-01");
    const { data } = JSON.parse(out) as { data: { requests: Array<Record<string, unknown>> } };
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sellers/<id>/report/download",
      query: ["from", "to"],
      body: ["pobIds[]", "filters.type"],
      authHeaders: ["x-csrf-token"],
    });
  });

  test("unmasked: values included", () => {
    const out = harSummary({ path: har, firstParty: ["example.com"], mask: false }, fs);
    expect(out).toContain(uuid);
    expect(out).toContain("DV00302423");
  });
});

describe("filterState", () => {
  test("keeps only cookies and origins for the given domains", () => {
    const p = writeState(
      "filter.json",
      [
        { name: "a", value: "1", domain: ".app.example.com" },
        { name: "b", value: "2", domain: "example.com" },
        { name: "g", value: "3", domain: ".google.com" },
      ],
      [{ origin: "https://app.example.com" }, { origin: "https://accounts.google.com" }],
    );
    const r = JSON.parse(filterState({ path: p, domains: ["example.com"] }, fs)) as {
      data: unknown;
    };
    expect(r.data).toEqual({ cookies: 2, dropped: 1 });
    const s = JSON.parse(readFileSync(p, "utf8")) as {
      cookies: Array<{ name: string }>;
      origins: unknown[];
    };
    expect(s.cookies.map((c) => c.name)).toEqual(["a", "b"]);
    expect(s.origins).toEqual([{ origin: "https://app.example.com" }]);
  });
});
