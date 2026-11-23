import { describe, expect, test } from "bun:test";
import {
  AGENT_BROWSER_VERSION,
  browser,
  browserSetupSteps,
  browserOk,
  loadSession,
  parseBrowserResult,
  saveSession,
  shellQuote,
} from "../src/index";

describe("shellQuote", () => {
  test("wraps in single quotes and escapes embedded ones", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("browser()", () => {
  test("puts --json and global options before the command", () => {
    const b = browser({ session: "brand-1", state: "/tmp/s.json", downloadPath: "/tmp/dl" });
    expect(b.open("https://x.example.com/login")).toBe(
      "agent-browser --json --session 'brand-1' --state '/tmp/s.json' --download-path '/tmp/dl' " +
        "open 'https://x.example.com/login'",
    );
  });

  test("fill keeps text literal after --", () => {
    expect(browser().fill("#q", "--help")).toBe("agent-browser --json fill '#q' -- '--help'");
  });

  test("waits carry --timeout in whole milliseconds", () => {
    const b = browser();
    expect(b.waitForUrl("**/dashboard", { timeoutMs: 30_000.4 })).toBe(
      "agent-browser --json wait --url '**/dashboard' --timeout 30000",
    );
    expect(b.waitForText("Welcome")).toBe("agent-browser --json wait --text 'Welcome'");
    expect(b.waitForFn("!location.hash.startsWith('#/login')", { timeoutMs: 1000 })).toBe(
      "agent-browser --json wait --fn '!location.hash.startsWith('\\''#/login'\\'')' --timeout 1000",
    );
    expect(b.waitForDownload("/tmp/r.xlsx", { timeoutMs: 5000 })).toBe(
      "agent-browser --json wait --download '/tmp/r.xlsx' --timeout 5000",
    );
  });

  test("state and download commands", () => {
    const b = browser();
    expect(b.stateSave("/tmp/s.json")).toBe("agent-browser --json state save '/tmp/s.json'");
    expect(b.stateLoad("/tmp/s.json")).toBe("agent-browser --json state load '/tmp/s.json'");
    expect(b.download("#report", "/tmp/r.xlsx")).toBe(
      "agent-browser --json download '#report' '/tmp/r.xlsx'",
    );
  });
});

describe("parseBrowserResult / browserOk", () => {
  test("reads the { success, data, error } envelope", () => {
    const r = parseBrowserResult<{ url: string }>(
      '{"success":true,"data":{"url":"https://x/dash"},"error":null}\n',
    );
    expect(r).toEqual({ success: true, data: { url: "https://x/dash" }, error: null });
  });

  test("returns null for anything else", () => {
    expect(parseBrowserResult("not json")).toBeNull();
    expect(parseBrowserResult('{"ok":true}')).toBeNull();
  });

  test("browserOk checks an already-parsed value", () => {
    expect(browserOk({ success: true, data: null, error: null })).toBe(true);
    expect(browserOk({ success: false, data: null, error: "Timeout" })).toBe(false);
    expect(browserOk(undefined)).toBe(false);
    expect(browserOk("success")).toBe(false);
  });
});

function recorder() {
  const ops: Array<[string, ...unknown[]]> = [];
  return {
    ops,
    exec: (cmd: string, opts?: { name?: string }) => ops.push(["exec", cmd, opts?.name]),
    readFileBytes: (path: string, as: string) => ops.push(["readFileBytes", path, as]),
    writeFileBytes: (path: string, bytes: Uint8Array) => ops.push(["writeFileBytes", path, bytes]),
    deleteFile: (path: string) => ops.push(["deleteFile", path]),
  };
}

describe("saveSession / loadSession", () => {
  test("save writes, reads as bytes, then deletes the file", () => {
    const sb = recorder();
    saveSession(sb, "session");
    expect(sb.ops).toEqual([
      [
        "exec",
        "agent-browser --json state save '/tmp/alineo-browser-state.json'",
        "browser.session.save",
      ],
      ["readFileBytes", "/tmp/alineo-browser-state.json", "session"],
      ["deleteFile", "/tmp/alineo-browser-state.json"],
    ]);
  });

  test("load writes the bytes, starts the browser, loads, then deletes the file", () => {
    const sb = recorder();
    const bytes = new Uint8Array([123, 125]);
    loadSession(sb, bytes, { session: "s1", path: "/tmp/x.json" });
    expect(sb.ops.map((o) => o[0])).toEqual(["writeFileBytes", "exec", "exec", "deleteFile"]);
    expect(sb.ops[0]).toEqual(["writeFileBytes", "/tmp/x.json", bytes]);
    expect(sb.ops[1]?.[1]).toBe("agent-browser --json --session 's1' open 'about:blank'");
    expect(sb.ops[2]?.[1]).toBe("agent-browser --json --session 's1' state load '/tmp/x.json'");
  });
});

describe("browserSetupSteps", () => {
  test("installs the pinned version, and never runs install --with-deps", () => {
    const [step] = browserSetupSteps();
    expect(step?.run).toContain(`npm install -g agent-browser@${AGENT_BROWSER_VERSION} &`);
    expect(step?.run).not.toContain("--with-deps");
    expect(step?.run.trimEnd().endsWith("agent-browser install")).toBe(true);
  });

  test("takes another version, and rejects one that is not a plain version string", () => {
    expect(browserSetupSteps({ version: "0.44.0-beta.1" })[0]?.run).toContain(
      "agent-browser@0.44.0-beta.1 &",
    );
    expect(() => browserSetupSteps({ version: "1; rm -rf /" })).toThrow(/invalid/);
  });
});
