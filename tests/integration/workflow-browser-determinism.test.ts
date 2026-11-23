/**
 * inspect() masking, the pinned environment, HAR summary, and session API calls, against a
 * local fixture site that runs inside each sandbox.
 *
 * The fixture's report page holds fake "client" data. Its Export button calls
 * POST /api/places, then POST /api/report/download with the place ids, and downloads the xlsx.
 * The second sandbox gets the same file through b.session.request with stored session bytes,
 * without starting a browser.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { workflow, type SandboxBuilder } from "@alineo-labs/workflow";
import {
  DEFAULT_BLOCK_HOSTS,
  browser,
  browserEnv,
  browserOk,
  browserSetupSteps,
  parseInspect,
  ref,
} from "@alineo-labs/agent-browser";
import { expect, test } from "bun:test";

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const PREBUILT_IMAGE = process.env.WORKFLOW_BROWSER_IMAGE;
const BASE = "http://127.0.0.1:3000";
const PASSWORD = "fixture-password-7f3a";
const REPORT = [0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x41, 0x0a];

// Fake data the masked inspection must never return.
const UUID = "c72f9e4f-94f5-4a1a-87e3-41a0aaf0f3aa";
const SECRETS = ["ACME TRADERS", "123456", "DV00302423", UUID, "27AAAAA0000A1Z5", "pw-secret-123"];

const FIXTURE = `
const http = require("node:http");
const crypto = require("node:crypto");
const SID = crypto.createHash("sha256").update("fixture-secret:demo").digest("hex");
const REPORT = Buffer.from(${JSON.stringify(REPORT)});
let trackerHits = 0;
const signedIn = (req) => (req.headers.cookie || "").split(/; */).includes("sid=" + SID);
const page = (res, body) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><head><title>Reports</title></head><body>" + body + "</body></html>"); };
const go = (res, to, h = {}) => { res.writeHead(302, { location: to, ...h }); res.end(); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/tracker") { trackerHits++; res.writeHead(204); return res.end(); }
  if (url.pathname === "/tracker-hits") { res.writeHead(200); return res.end(String(trackerHits)); }
  if (req.method === "POST" && url.pathname === "/login") {
    const f = new URLSearchParams(await readBody(req));
    if (f.get("username") === "demo" && f.get("password") === ${JSON.stringify(PASSWORD)})
      return go(res, "/reports", { "set-cookie": "sid=" + SID + "; Path=/; HttpOnly; Max-Age=86400" });
    return go(res, "/login?error=1");
  }
  if (url.pathname === "/login") return page(res, '<form method="post" action="/login"><input id="username" name="username"><input id="password" name="password" type="password"><button id="submit" type="submit">Sign in</button></form>');
  if (!signedIn(req)) {
    if (url.pathname.startsWith("/api/")) { res.writeHead(401); return res.end(); }
    return go(res, "/login");
  }
  if (url.pathname === "/reports") return page(res,
    '<a href="/sellers/${UUID}/profile">Profile</a>' +
    '<label for="place">Place of business</label><select id="place"><option value="DV00302423">ACME TRADERS - 302423</option><option value="all">All</option></select>' +
    '<label for="gstin">GSTIN</label><input id="gstin" value="27AAAAA0000A1Z5">' +
    '<label for="pin">PIN</label><input id="pin" type="password" value="pw-secret-123">' +
    '<table><tr><th>Party</th><th>Amount</th></tr><tr><td>ACME TRADERS</td><td>123456</td></tr></table>' +
    '<div role="dialog" aria-label="Notice"><button>Close</button></div>' +
    '<button id="export">Export</button>' +
    '<script>document.getElementById("export").onclick = async () => {' +
    ' const places = await (await fetch("/api/places", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();' +
    ' const r = await fetch("/api/report/download?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pobIds: places.data.map((p) => p.id) }) });' +
    ' const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "report.xlsx"; document.body.appendChild(a); a.click(); };</script>');
  if (req.method === "POST" && url.pathname === "/api/places") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "P1" }, { id: "P2" }] }));
  }
  if (req.method === "POST" && url.pathname === "/api/report/download") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!url.searchParams.get("from") || !url.searchParams.get("to") || (body.pobIds || []).join() !== "P1,P2") { res.writeHead(400); return res.end(); }
    res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return res.end(REPORT);
  }
  res.writeHead(404); res.end();
}).listen(3000, "127.0.0.1");
`;

const SANDBOX = {
  image: PREBUILT_IMAGE ?? "node:22-bookworm-slim",
  resources: { cpu: "1", memory: "1536Mi" },
};

function startFixture(sb: SandboxBuilder): void {
  sb.writeFile("/tmp/fixture.cjs", FIXTURE);
  sb.exec(
    "setsid nohup node /tmp/fixture.cjs > /tmp/fixture.log 2>&1 < /dev/null & disown; " +
      `node -e 'const t=Date.now();(async function p(){try{await fetch("${BASE}/login");}` +
      `catch(e){if(Date.now()-t>10000)process.exit(1);await new Promise(r=>setTimeout(r,200));return p();}})()'`,
    { name: "fixture.start" },
  );
}

function client(): Sandbox {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
}

const PROBE = `JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lang: navigator.language,
  ua: navigator.userAgent,
  width: innerWidth,
})`;
const TRACKER = `fetch("${BASE}/tracker").then(() => "reached", () => "blocked")`;

test(
  "inspect masks by default, the environment is pinned, and the report API works with and without a browser",
  async () => {
    const b = browser(
      browserEnv({
        timezone: "Asia/Tokyo",
        blockHosts: [...DEFAULT_BLOCK_HOSTS, "*://127.0.0.1:3000/tracker*"],
      }),
    );
    const call =
      (req: Parameters<typeof b.session.request>[1], as: string) => (sb: SandboxBuilder) =>
        b.session.request(sb, req, { as, strict: false });

    const first = await workflow(client())
      .sandbox(SANDBOX, (sb) => {
        if (PREBUILT_IMAGE === undefined) {
          for (const s of browserSetupSteps()) sb.exec(s.run, { timeoutMs: 15 * 60_000 });
        }
        startFixture(sb);
        for (const c of b.setup()) sb.exec(c, { name: "browser.setup" });
        sb.exec(b.eval(PROBE), { as: "env", parse: "json" });
        sb.exec(b.eval(TRACKER), { as: "tracker", parse: "json" });
        sb.exec(
          `node -e 'fetch("${BASE}/tracker-hits").then(r=>r.text()).then(t=>process.stdout.write(t))'`,
          { as: "trackerHits" },
        );

        sb.exec(b.open(`${BASE}/login`));
        sb.exec(b.fill("#username", "demo"));
        sb.exec(b.fill("#password", PASSWORD));
        sb.exec(b.click("#submit"));
        sb.exec(b.waitForUrl("**/reports", { timeoutMs: 15_000 }));

        sb.exec(b.inspect(), { as: "masked", parse: "json" });
        sb.exec(b.inspect({ mask: false }), { as: "raw", parse: "json" });

        sb.exec(b.har.start());
        sb.exec(b.click("#export"));
        sb.exec(b.waitForDownload("/tmp/ui.xlsx", { timeoutMs: 20_000 }));
        sb.exec(b.har.stop("/tmp/r.har"));
        sb.exec(b.har.summary("/tmp/r.har", { firstParty: ["127.0.0.1"] }), {
          as: "har",
          parse: "json",
        });
        sb.deleteFile("/tmp/r.har");

        sb.exec(b.session.dump("/tmp/s.json"));
        call(
          {
            method: "POST",
            url: `${BASE}/api/places`,
            session: "/tmp/s.json",
            json: {},
            out: "/tmp/places.json",
            pick: { ids: "data[].id" },
          },
          "places",
        )(sb);
        call(
          {
            method: "POST",
            url: `${BASE}/api/report/download`,
            session: "/tmp/s.json",
            query: { from: "2026-10-01", to: "2026-10-31" },
            json: { pobIds: ref("/tmp/places.json", "data[].id") },
            out: "/tmp/api.xlsx",
            expect: { contentType: /spreadsheetml/, magic: "PK" },
            deleteSession: true,
          },
          "download",
        )(sb);
        sb.readFileBytes("/tmp/api.xlsx", "apiReport");
        sb.readFileBytes("/tmp/ui.xlsx", "uiReport");
        b.session.save(sb, "session", { domains: ["127.0.0.1"] });
      })
      .result();

    const v = first.vars;
    // Pinned environment.
    const env = JSON.parse((v.env as { data: { result: string } }).data.result) as {
      tz: string;
      lang: string;
      ua: string;
      width: number;
    };
    expect(env).toMatchObject({ tz: "Asia/Tokyo", lang: "en-US", width: 1440 });
    expect(env.ua).toContain("Chrome/158.0.0.0");
    expect((v.tracker as { data: { result: string } }).data.result).toBe("blocked");
    expect(v.trackerHits).toBe("0");

    // Masked inspection: structure, no data.
    const masked = parseInspect(v.masked);
    expect(masked).not.toBeNull();
    const maskedText = JSON.stringify(masked);
    for (const s of SECRETS) expect(maskedText).not.toContain(s);
    expect(masked!.counts.rows).toBe(2);
    expect(masked!.elements.some((e) => e.id === "export" && e.label === "Export")).toBe(true);
    expect(masked!.dialogs[0]?.buttons).toEqual(["Close"]);
    expect(masked!.inputs.find((i) => i.id === "gstin")?.value).toBe("<set>");

    // Unmasked: labels and values as the page has them, but never the password.
    const raw = parseInspect(v.raw);
    const rawText = JSON.stringify(raw);
    expect(rawText).toContain(UUID);
    expect(rawText).toContain("27AAAAA0000A1Z5");
    expect(rawText).toContain("DV00302423");
    expect(rawText).not.toContain("pw-secret-123");

    // HAR summary: the two API calls, names and keys only.
    const harText = JSON.stringify(v.har);
    expect(harText).not.toContain("2026-10-01");
    expect(harText).not.toContain("P1");
    const reqs = (
      v.har as {
        data: {
          requests: Array<{ method: string; path: string; query: string[]; body?: string[] }>;
        };
      }
    ).data.requests;
    expect(reqs.find((r) => r.path === "/api/report/download")).toMatchObject({
      method: "POST",
      query: ["from", "to"],
      body: ["pobIds[]"],
    });
    expect(reqs.some((r) => r.path === "/api/places")).toBe(true);

    // Session API chain: same bytes as the UI export.
    expect((v.places as { data: { picked: unknown } }).data.picked).toEqual({ ids: ["P1", "P2"] });
    expect(browserOk(v.download)).toBe(true);
    expect(Array.from(v.apiReport as Uint8Array)).toEqual(REPORT);
    expect(Array.from(v.uiReport as Uint8Array)).toEqual(REPORT);

    // Saved session: fixture cookies only.
    const session = v.session as Uint8Array;
    const state = JSON.parse(new TextDecoder().decode(session)) as {
      cookies: Array<{ domain: string }>;
    };
    expect(state.cookies.length).toBeGreaterThan(0);
    expect(state.cookies.every((c) => c.domain === "127.0.0.1")).toBe(true);

    // Second sandbox: stored bytes only, no browser started.
    const second = await workflow(client())
      .sandbox({ image: SANDBOX.image, resources: { cpu: "500m", memory: "512Mi" } }, (sb) => {
        startFixture(sb);
        sb.writeFileBytes("/tmp/s.json", session);
        call(
          {
            method: "POST",
            url: `${BASE}/api/places`,
            session: "/tmp/s.json",
            json: {},
            out: "/tmp/places.json",
          },
          "places",
        )(sb);
        call(
          {
            method: "POST",
            url: `${BASE}/api/report/download`,
            session: "/tmp/s.json",
            query: { from: "2026-10-01", to: "2026-10-31" },
            json: { pobIds: ref("/tmp/places.json", "data[].id") },
            out: "/tmp/api.xlsx",
            expect: { contentType: /spreadsheetml/, magic: "PK" },
          },
          "download",
        )(sb);
        sb.readFileBytes("/tmp/api.xlsx", "apiReport");
        sb.writeFile("/tmp/empty.json", '{"cookies":[]}');
        call(
          { method: "POST", url: `${BASE}/api/places`, session: "/tmp/empty.json", json: {} },
          "noSession",
        )(sb);
        sb.exec("pgrep -f 'chrome|agent-browser' >/dev/null && echo running || echo none", {
          as: "browserProcs",
        });
      })
      .result();

    expect(browserOk(second.vars.download)).toBe(true);
    expect(Array.from(second.vars.apiReport as Uint8Array)).toEqual(REPORT);
    expect(second.vars.noSession).toMatchObject({ success: false, code: "auth_expired" });
    expect(second.vars.browserProcs).toBe("none");
  },
  40 * 60_000,
);
