import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BLOCK_HOSTS,
  DEFAULT_USER_AGENT,
  browser,
  browserEnv,
  inspectOnFailure,
  parseInspect,
} from "../src/index";

const decode = (cmd: string): string => {
  const m = cmd.match(/(?:-b '|printf %s ')([A-Za-z0-9+/=]+)'/);
  if (!m?.[1]) throw new Error(`no base64 in ${cmd}`);
  return Buffer.from(m[1], "base64").toString("utf8");
};

describe("browserEnv / setup", () => {
  test("pins user agent, locale, timezone, timeout, tab and input mode on every command", () => {
    const b = browser(browserEnv({ timezone: "Asia/Kolkata" }));
    expect(b.open("https://x.example.com")).toBe(
      "TZ='Asia/Kolkata' AGENT_BROWSER_DEFAULT_TIMEOUT=30000 agent-browser --json " +
        `--user-agent '${DEFAULT_USER_AGENT}' --args '--lang=en-US' --pin-tab --input-mode 'instant' ` +
        "open 'https://x.example.com'",
    );
  });

  test("setup launches on about:blank, sets the viewport, then blocks hosts", () => {
    const cmds = browser({
      viewport: { width: 1440, height: 900 },
      blockHosts: DEFAULT_BLOCK_HOSTS,
    }).setup();
    expect(cmds[0]).toBe("agent-browser --json open");
    expect(cmds[1]).toBe("agent-browser --json set viewport 1440 900");
    expect(cmds.slice(2)).toEqual(
      DEFAULT_BLOCK_HOSTS.map((p) => `agent-browser --json network route '${p}' --abort`),
    );
  });

  test("the default block list leaves Google's own domains alone (reCAPTCHA)", () => {
    expect(DEFAULT_BLOCK_HOSTS.some((p) => /\.google\.com|gstatic/.test(p))).toBe(false);
  });
});

describe("inspect", () => {
  test("masks by default, and passes words and scope into the page script", () => {
    const script = decode(browser().inspect({ words: ["Dropship"], scope: "#main" }));
    expect(script).toContain('"mask":true');
    expect(script).toContain('"dropship"');
    expect(script).toContain('"scope":"#main"');
  });

  test("mask: false is passed through", () => {
    expect(decode(browser().inspect({ mask: false }))).toContain('"mask":false');
  });

  test("parseInspect reads the eval envelope, from stdout or an already-parsed value", () => {
    const page = {
      masked: true,
      counts: { tables: 1, rows: 3, iframes: 0 },
      iframes: [],
      dialogs: [],
      inputs: [],
      elements: [],
    };
    const env = { success: true, data: { result: JSON.stringify(page) }, error: null };
    expect(parseInspect(JSON.stringify(env))).toEqual(page);
    expect(parseInspect(env)).toEqual(page);
    expect(parseInspect({ success: false, data: null, error: "x" })).toBeNull();
    expect(parseInspect("nope")).toBeNull();
  });

  test("inspectOnFailure queues an inspect only when the last exec failed", () => {
    const calls: unknown[] = [];
    let pred: ((c: { exitCode: number }) => boolean) | undefined;
    type Fake = {
      exec(cmd: string, o?: unknown): unknown;
      when(p: (c: { exitCode: number }) => boolean, then: (s: Fake) => void): unknown;
    };
    const sb: Fake = {
      exec: (cmd: string, o?: unknown) => calls.push([cmd, o]),
      when: (p: (c: { exitCode: number }) => boolean, then: (s: Fake) => void) => {
        pred = p;
        then(sb);
      },
    };
    inspectOnFailure(sb, browser(), "page");
    expect(pred?.({ exitCode: 1 })).toBe(true);
    expect(pred?.({ exitCode: 0 })).toBe(false);
    expect(calls[0]).toMatchObject([
      expect.stringContaining("eval -b"),
      { as: "page", parse: "json", strict: false },
    ]);
  });
});

describe("session and har commands", () => {
  const recorder = () => {
    const ops: Array<[string, ...unknown[]]> = [];
    return {
      ops,
      exec: (cmd: string, o?: unknown) => ops.push(["exec", cmd, o]),
      readFileBytes: (p: string, as: string) => ops.push(["readFileBytes", p, as]),
      writeFileBytes: (p: string, bytes: Uint8Array) => ops.push(["writeFileBytes", p, bytes]),
      deleteFile: (p: string) => ops.push(["deleteFile", p]),
    };
  };

  test("dump is a state save that stays in the sandbox", () => {
    expect(browser().session.dump("/tmp/s.json")).toBe(
      "agent-browser --json state save '/tmp/s.json'",
    );
  });

  test("save with domains: dump, filter, read bytes, delete", () => {
    const sb = recorder();
    browser().session.save(sb, "session", { domains: ["example.com"] });
    expect(sb.ops.map((o) => o[0])).toEqual(["exec", "exec", "readFileBytes", "deleteFile"]);
    expect(decode(sb.ops[1]![1] as string)).toContain('"domains":["example.com"]');
  });

  test("request puts the config in env, not in the command text", () => {
    const sb = recorder();
    browser().session.request(
      sb,
      { method: "POST", url: "https://app.example.com/api/x", json: { secretish: "v" } },
      { as: "dl", strict: false },
    );
    const [, cmd, opts] = sb.ops[0] as [
      string,
      string,
      { env: Record<string, string>; as: string; strict: boolean },
    ];
    expect(cmd).not.toContain("app.example.com");
    expect(decode(cmd)).not.toContain("secretish");
    expect(JSON.parse(opts.env.AB_SESSION_REQUEST!)).toMatchObject({
      url: "https://app.example.com/api/x",
      json: { secretish: "v" },
    });
    expect(opts).toMatchObject({ as: "dl", strict: false, parse: "json" });
  });

  test("har commands", () => {
    const b = browser();
    expect(b.har.start()).toBe("agent-browser --json network har start --content none");
    expect(b.har.stop("/tmp/x.har")).toBe("agent-browser --json network har stop '/tmp/x.har'");
    expect(decode(b.har.summary("/tmp/x.har", { firstParty: ["example.com"] }))).toContain(
      '"mask":true',
    );
  });
});
