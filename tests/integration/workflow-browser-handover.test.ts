/**
 * handover(): a workflow hands its browser to a "person" and continues when they are done.
 *
 * The fixture page is one full-screen button that leads to /done. The test plays the person:
 * it relays the live view with relayBrowserStream, waits for the first frame, and clicks the
 * middle of the viewport. The workflow's wait step sees /done and the workflow finishes.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { workflow, type WorkflowEvent } from "@alineo-labs/workflow";
import {
  browser,
  browserSetupSteps,
  handover,
  relayBrowserStream,
  type BrowserStreamRelay,
} from "@alineo-labs/agent-browser";
import { expect, test } from "bun:test";

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const PREBUILT_IMAGE = process.env.WORKFLOW_BROWSER_IMAGE;
const BASE = "http://127.0.0.1:3000";

const FIXTURE = `
const http = require("node:http");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url === "/done") return res.end("<!doctype html><title>Done</title><h1 id=done>Done</h1>");
  res.end('<!doctype html><title>Gate</title><style>html,body{margin:0;height:100%}' +
    'button{width:100vw;height:100vh}</style>' +
    '<button onclick="location.href=\\'/done\\'">Continue</button>');
}).listen(3000, "127.0.0.1");
`;

function client(): Sandbox {
  return new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
}

interface FrameMessage {
  type: string;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
}

test(
  "a person finishes a step through the live view and the workflow continues",
  async () => {
    const b = browser();
    const seen = new Set<string>();
    let relay: BrowserStreamRelay | undefined;
    let clicked = false;
    let ended = false;
    const events: WorkflowEvent[] = [];

    const person = {
      send(message: string) {
        const m = JSON.parse(message) as FrameMessage;
        seen.add(m.type);
        if (m.type !== "frame" || clicked || relay === undefined) return;
        clicked = true;
        const x = Math.round((m.metadata?.deviceWidth ?? 1280) / 2);
        const y = Math.round((m.metadata?.deviceHeight ?? 720) / 2);
        for (const eventType of ["mousePressed", "mouseReleased"]) {
          relay.fromViewer(
            JSON.stringify({ type: "input_mouse", eventType, x, y, button: "left", clickCount: 1 }),
          );
        }
      },
      close() {},
    };

    const result = await workflow(client(), { onEvent: (e) => events.push(e) })
      .sandbox(
        {
          image: PREBUILT_IMAGE ?? "node:22-bookworm-slim",
          resources: { cpu: "1", memory: "1536Mi" },
        },
        (sb) => {
          if (PREBUILT_IMAGE === undefined) {
            for (const s of browserSetupSteps()) sb.exec(s.run, { timeoutMs: 15 * 60_000 });
          }
          sb.writeFile("/tmp/fixture.cjs", FIXTURE);
          sb.exec(
            "setsid nohup node /tmp/fixture.cjs > /tmp/fixture.log 2>&1 < /dev/null & disown; sleep 1",
          );
          sb.exec(b.open(`${BASE}/`));
          handover(sb, b, {
            name: "person",
            until: { url: "**/done" },
            timeoutMs: 60_000,
            onLive: (stream) => {
              relay = relayBrowserStream(stream, person);
            },
            onEnd: () => {
              ended = true;
              relay?.close();
            },
          });
          sb.exec(b.getUrl(), { as: "url", parse: "json" });
        },
      )
      .result();

    expect(clicked).toBe(true);
    expect(ended).toBe(true);
    expect(seen.has("frame")).toBe(true);
    expect(JSON.stringify(result.vars.url)).toContain("/done");
    const names = events.filter((e) => e.type === "step.completed").map((e) => e.name);
    expect(names).toContain("person: live view");
    expect(names).toContain("person: wait");
    expect(names).toContain("person: end live view");
  },
  20 * 60_000,
);
