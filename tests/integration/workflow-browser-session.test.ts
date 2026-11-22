/**
 * A deterministic browser workflow with no LLM: log in to a site, save the session, then reuse
 * it in a second, fresh sandbox to download a binary file without logging in again.
 *
 * The site is a local fixture served inside each sandbox. Its session cookie is derived from a
 * fixed secret, so the cookie from sandbox 1 is valid on sandbox 2's server, like a real site.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { workflow, type SandboxBuilder, type WorkflowEvent } from "@alineo-labs/workflow";
import {
  browser,
  browserOk,
  browserSetupSteps,
  loadSession,
  saveSession,
} from "@alineo-labs/agent-browser";
import { expect, test } from "bun:test";

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const BASE = "http://127.0.0.1:3000";
const PASSWORD = "fixture-password-7f3a";

// Not valid UTF-8 (0xff, 0xfe, a lone 0x80): a string read would corrupt it.
const REPORT = [0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x41, 0x0a];

const FIXTURE = `
const http = require("node:http");
const crypto = require("node:crypto");
const SID = crypto.createHash("sha256").update("fixture-secret:demo").digest("hex");
const REPORT = Buffer.from(${JSON.stringify(REPORT)});
const signedIn = (req) => (req.headers.cookie || "").split(/; */).includes("sid=" + SID);
const page = (res, body) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><body>" + body + "</body></html>");
};
const go = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      if (f.get("username") === "demo" && f.get("password") === ${JSON.stringify(PASSWORD)}) {
        go(res, "/dashboard", { "set-cookie": "sid=" + SID + "; Path=/; HttpOnly; Max-Age=86400" });
      } else go(res, "/login?error=1");
    });
    return;
  }
  if (url.pathname === "/login") {
    return page(res, '<form method="post" action="/login">' +
      '<input id="username" name="username"><input id="password" name="password" type="password">' +
      '<button id="submit" type="submit">Sign in</button></form>');
  }
  if (!signedIn(req)) return go(res, "/login");
  if (url.pathname === "/dashboard") {
    return page(res, '<h1>Reports</h1><a id="report" href="/report.bin" download="report.bin">Download</a>');
  }
  if (url.pathname === "/report.bin") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="report.bin"',
    });
    return res.end(REPORT);
  }
  res.writeHead(404); res.end();
}).listen(3000, "127.0.0.1");
`;

// An image that already has node, agent-browser and Chrome (for example a cached alineod
// snapshot) skips the install. Without one, the test installs them into node:22-bookworm-slim.
const PREBUILT_IMAGE = process.env.WORKFLOW_BROWSER_IMAGE;
const SANDBOX = {
  image: PREBUILT_IMAGE ?? "node:22-bookworm-slim",
  resources: { cpu: "1", memory: "1536Mi" },
};

function setUp(sb: SandboxBuilder): void {
  if (PREBUILT_IMAGE === undefined) {
    for (const step of browserSetupSteps()) {
      sb.exec(step.run, { name: "browser.setup", timeoutMs: 15 * 60_000 });
    }
  }
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

test(
  "log in once, then reuse the saved session in a fresh sandbox to download a binary file",
  async () => {
    const b = browser();
    const events: WorkflowEvent[] = [];

    // Run 1: log in with the form, save the session, download the report.
    const first = await workflow(client(), { onEvent: (e) => events.push(e) })
      .sandbox(SANDBOX, (sb) => {
        setUp(sb);
        sb.exec(b.open(`${BASE}/login`), { name: "open login" });
        sb.exec(b.fill("#username", "demo"), { name: "fill username" });
        sb.exec(b.fill("#password", PASSWORD), { name: "fill password" });
        sb.exec(b.click("#submit"), { name: "submit" });
        sb.exec(b.waitForUrl("**/dashboard", { timeoutMs: 15_000 }), {
          name: "wait for dashboard",
          as: "login",
          parse: "json",
        });
        saveSession(sb, "session");
        sb.exec(b.download("#report", "/tmp/report.bin"), { name: "download" });
        sb.readFileBytes("/tmp/report.bin", "report");
      })
      .result();

    expect(browserOk(first.vars.login)).toBe(true);
    expect(Array.from(first.vars.report as Uint8Array)).toEqual(REPORT);
    const session = first.vars.session as Uint8Array;
    expect(new TextDecoder().decode(session)).toContain("sid");

    // Step events name each step and never carry the command text.
    expect(events[0]?.type).toBe("workflow.started");
    expect(events.at(-1)?.type).toBe("workflow.completed");
    expect(events.some((e) => e.type === "step.completed" && e.name === "fill password")).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(PASSWORD);

    // Run 2: a fresh sandbox. Without the session the dashboard sends us to the login page.
    // With it, the dashboard opens and the download works with no login step.
    const second = await workflow(client())
      .sandbox(SANDBOX, (sb) => {
        setUp(sb);
        sb.exec(b.open(`${BASE}/dashboard`));
        sb.exec(b.waitForUrl("**/dashboard", { timeoutMs: 3_000 }), {
          as: "before",
          parse: "json",
          strict: false,
        });
        loadSession(sb, session);
        sb.exec(b.open(`${BASE}/dashboard`));
        sb.exec(b.waitForUrl("**/dashboard", { timeoutMs: 15_000 }), {
          as: "after",
          parse: "json",
          strict: false,
        });
        sb.exec(b.download("#report", "/tmp/report.bin"));
        sb.readFileBytes("/tmp/report.bin", "report");
        sb.exec("test ! -e /tmp/alineo-browser-state.json", { name: "state file removed" });
      })
      .result();

    expect(browserOk(second.vars.before)).toBe(false);
    expect(browserOk(second.vars.after)).toBe(true);
    expect(Array.from(second.vars.report as Uint8Array)).toEqual(REPORT);
  },
  40 * 60_000,
);
