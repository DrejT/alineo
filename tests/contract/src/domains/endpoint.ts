import { describe, expect, test } from "bun:test";
import type { ProviderBinding } from "../binding";
import { withSandbox } from "../helpers";

const PORT = 8123;

export function endpointDomain(binding: ProviderBinding): void {
  describe(`${binding.name}: endpoint`, () => {
    test("an HTTP server inside the sandbox is reachable from the host", async () => {
      await withSandbox(binding, "endpoint-http", async (sb) => {
        await sb.writeFile(
          "/workspace/server.py",
          [
            "from http.server import BaseHTTPRequestHandler, HTTPServer",
            "class H(BaseHTTPRequestHandler):",
            "    def do_GET(self):",
            "        self.send_response(200)",
            "        self.end_headers()",
            "        self.wfile.write(b'pong')",
            `HTTPServer(('0.0.0.0', ${PORT}), H).serve_forever()`,
            "",
          ].join("\n"),
        );
        await sb.exec("nohup python3 /workspace/server.py >/tmp/server.log 2>&1 &");
        await waitFor(async () => {
          const r = await sb.exec(
            `python3 -c "import socket;socket.create_connection(('127.0.0.1',${PORT}),1)"`,
            {
              strict: false,
            },
          );
          return r.exitCode === 0;
        });

        const { url, headers } = await sb.proxy(PORT);
        const res = await fetch(url, { headers });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("pong");
      });
    });

    // The Pi bridge streams over SSE through this path, and a proxy that closes an idle
    // connection ends the turn. This holds the stream silent, then sends again.
    test("an SSE stream survives a silent gap", async () => {
      const idle = binding.sseIdleSeconds ?? 20;
      await withSandbox(binding, "endpoint-sse", async (sb) => {
        await sb.writeFile(
          "/workspace/sse.py",
          [
            "import time",
            "from http.server import BaseHTTPRequestHandler, HTTPServer",
            "class H(BaseHTTPRequestHandler):",
            "    def do_GET(self):",
            "        self.send_response(200)",
            "        self.send_header('Content-Type', 'text/event-stream')",
            "        self.send_header('Cache-Control', 'no-cache')",
            "        self.end_headers()",
            "        self.wfile.write(b'data: first\\n\\n'); self.wfile.flush()",
            `        time.sleep(${idle})`,
            "        self.wfile.write(b'data: second\\n\\n'); self.wfile.flush()",
            `HTTPServer(('0.0.0.0', ${PORT + 1}), H).serve_forever()`,
            "",
          ].join("\n"),
        );
        await sb.exec("nohup python3 /workspace/sse.py >/tmp/sse.log 2>&1 &");
        await waitFor(async () => {
          const r = await sb.exec(
            `python3 -c "import socket;socket.create_connection(('127.0.0.1',${PORT + 1}),1)"`,
            {
              strict: false,
            },
          );
          return r.exitCode === 0;
        });

        const { url, headers } = await sb.proxy(PORT + 1);
        const res = await fetch(url, { headers: { ...headers, accept: "text/event-stream" } });
        expect(res.status).toBe(200);

        const text = await readAll(res);
        expect(text).toContain("data: first");
        expect(text).toContain("data: second");
      });
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}
