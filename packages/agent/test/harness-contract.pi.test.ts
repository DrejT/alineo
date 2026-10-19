import { afterEach } from "bun:test";
import { createHarness, type FakeScenario, type HarnessSandbox } from "../src/harness";
import { defineHarnessContract } from "./harness-contract/contract";

/**
 * Binds the contract to `PiAdapter`, against a scripted bridge (a `fetch` stand-in that
 * speaks the bridge's HTTP+SSE). It proves `PiAdapter` and `fromPiEvent` keep the contract.
 * It does not prove Pi itself does: that needs a live run.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const enc = new TextEncoder();
const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const sandbox: HarnessSandbox = {
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  proxy: () => Promise.resolve({ url: "http://scripted-bridge", headers: {} }),
  writeFile: () => Promise.resolve(),
};

/** A bridge that plays `scenario` on the next `/prompt`. */
function scriptedBridge(scenario: FakeScenario): void {
  let active = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let permissionId: string | null = null;
  let pendingPerm: { tool: string; target: string; title: string } | null = null;
  let finishAfterPermission: ((allow: boolean) => void) | null = null;

  const send = (o: unknown) => controller?.enqueue(enc.encode(frame(o)));
  const end = () => {
    controller?.enqueue(enc.encode("data: [DONE]\n\n"));
    controller?.close();
    active = false;
    controller = null;
  };

  const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.replace("http://scripted-bridge", "");
    const method = init?.method ?? "GET";

    if (path === "/prompt" && method === "POST") {
      active = true;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          send({ type: "agent_start" });
          switch (scenario.kind) {
            case "text":
              send({ type: "text", text: scenario.text });
              send({ type: "agent_end", messages: [] });
              end();
              break;
            case "tool":
              send({ type: "tool_start", toolCallId: "t1", toolName: scenario.toolName, args: {} });
              send({
                type: "tool_end",
                toolCallId: "t1",
                toolName: scenario.toolName,
                result: scenario.result,
                isError: false,
              });
              send({ type: "agent_end", messages: [] });
              end();
              break;
            case "fail":
              send({ error: scenario.message });
              end();
              break;
            case "hang":
              break; // ends on /abort
            case "permission":
              permissionId = "perm-1";
              pendingPerm = {
                tool: scenario.tool,
                target: scenario.target,
                title: `Run ${scenario.tool}: ${scenario.target}`,
              };
              send({ type: "permission_request", requestId: permissionId, ...pendingPerm });
              finishAfterPermission = (allow) => {
                if (allow) {
                  send({
                    type: "tool_start",
                    toolCallId: "t1",
                    toolName: scenario.tool,
                    args: { target: scenario.target },
                  });
                  send({
                    type: "tool_end",
                    toolCallId: "t1",
                    toolName: scenario.tool,
                    result: "ok",
                    isError: false,
                  });
                } else {
                  // Pi's gate blocks the call and Pi reports the tool as failed.
                  send({
                    type: "tool_end",
                    toolCallId: "t1",
                    toolName: scenario.tool,
                    result: "blocked",
                    isError: true,
                  });
                }
                send({ type: "agent_end", messages: [] });
                end();
              };
              break;
          }
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if (path === "/abort") {
      if (active) end();
      return json(200, { ok: true, data: null });
    }
    if (path === "/steer") {
      // The real bridge answers 409 with no turn running (see pi-bridge.test.ts).
      return active
        ? json(200, { ok: true, data: null })
        : json(409, { ok: false, error: "no turn in progress" });
    }
    if (path === "/follow-up") return json(200, { ok: true, data: null });
    if (path === "/pending-permissions") {
      const pending =
        permissionId && pendingPerm ? [{ requestId: permissionId, ...pendingPerm, since: 0 }] : [];
      return json(200, { ok: true, data: { pending } });
    }
    if (path === "/permission-response") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        decision: { kind: string };
      };
      const allow = body.decision.kind !== "reject";
      permissionId = null;
      pendingPerm = null;
      send({
        type: "permission_resolved",
        requestId: "perm-1",
        decision: body.decision,
      });
      finishAfterPermission?.(allow);
      return json(200, { ok: true });
    }
    return json(404, { error: `unscripted ${path}` });
  };
  globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
}

defineHarnessContract({
  name: "pi (scripted bridge)",
  async create(scenario) {
    scriptedBridge(scenario);
    const adapter = createHarness("pi");
    await adapter.start(sandbox);
    return adapter;
  },
});
