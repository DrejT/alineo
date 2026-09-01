import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Drives the real pi-bridge.js against a stub `pi` process — covers the permission
 * hold/route/resolve protocol, batch-clear, and `/pending-permissions` without a sandbox.
 */

const dir = mkdtempSync(join(tmpdir(), "alineo-bridge-"));
const PORT = 3100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const bridgeSrc = fileURLToPath(new URL("../src/adapters/pi-bridge.js", import.meta.url));
const gatePath = fileURLToPath(new URL("../src/adapters/pi-permission-gate.js", import.meta.url));
// The package is `"type": "module"` but pi-bridge.js is CJS (it runs from the sandbox root,
// outside any package.json). Copy it to a `.cjs` so `node` treats it as CJS here too.
const bridgePath = join(mkdtempSync(join(tmpdir(), "alineo-bridge-bin-")), "bridge.cjs");
copyFileSync(bridgeSrc, bridgePath);

// Stub Pi: speaks just enough of the RPC line protocol. On `prompt`, emits two
// ALINEO_PERM select dialogs (same tool) so batch-clear is exercised. Echoes every
// extension_ui_response back as `__ui_ack__` so the test can assert what was sent.
const stubPi = `#!/usr/bin/env node
const rl = require("readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === "__probe__") { send({ id: "__probe__", type: "response", command: "get_state", success: true, data: { model: { id: "stub", api: "stub" } } }); return; }
  if (m.type === "prompt") {
    for (const n of [1, 2]) {
      send({ type: "extension_ui_request", id: "perm-" + n, method: "select",
        title: 'ALINEO_PERM {"tool":"bash","target":"cmd-' + n + '","title":"Run bash cmd-' + n + '"}',
        options: ["decide"] });
    }
    return;
  }
  if (m.type === "extension_ui_response") { send({ type: "__ui_ack__", id: m.id, value: m.value, cancelled: !!m.cancelled }); return; }
  if (m.id) send({ id: m.id, type: "response", success: true, data: null });
});
`;
const stubPath = join(dir, "stub-pi");
const configPath = join(dir, "alineo-pi.json");

let proc: ReturnType<typeof Bun.spawn>;

async function getJson<T>(url: string): Promise<T> {
  return (await (await fetch(url)).json()) as T;
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
      if (r.ok && body?.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("bridge did not become healthy");
}

type SseEvent = { type?: string; requestId?: string };

/** Consume the permission SSE stream in the background, recording event objects. */
function openPermissionStream(sink: SseEvent[], signal: AbortSignal) {
  void (async () => {
    const res = await fetch(`${BASE}/permission-stream`, { signal });
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (l.startsWith("data: ") && l.slice(6).trim() !== "[DONE]") {
            try {
              sink.push(JSON.parse(l.slice(6)) as SseEvent);
            } catch {}
          }
        }
      }
    } catch {}
  })();
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timeout waiting for condition");
}

beforeAll(async () => {
  writeFileSync(stubPath, stubPi);
  chmodSync(stubPath, 0o755);
  writeFileSync(configPath, JSON.stringify({ permissions: { default: "ask", rules: [] } }));
  proc = Bun.spawn(["node", bridgePath], {
    env: {
      ...process.env,
      ALINEO_BRIDGE_PORT: String(PORT),
      ALINEO_PI_BIN: stubPath,
      ALINEO_PI_CONFIG: configPath,
      ALINEO_PERMISSION_GATE_PATH: gatePath,
      ALINEO_ENV_FILE: join(dir, "nonexistent-env"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth();
});

afterAll(() => {
  try {
    proc.kill();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("pi-bridge permission protocol", () => {
  it("holds gate dialogs, routes them, resolves + batch-clears, tracks pending", async () => {
    const ac = new AbortController();
    const events: SseEvent[] = [];
    openPermissionStream(events, ac.signal);
    await Bun.sleep(200);

    // Kick a prompt so the stub emits perm-1 / perm-2.
    const promptAc = new AbortController();
    void fetch(`${BASE}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "go" }),
      signal: promptAc.signal,
    }).catch(() => {});

    await until(() =>
      events.filter((e) => e.type === "permission_request").length === 2 ? true : undefined,
    );

    // Both pending, visible via /pending-permissions.
    type PendingBody = { data: { pending: Array<{ requestId: string; tool: string }> } };
    const pending = (await getJson<PendingBody>(`${BASE}/pending-permissions`)).data.pending;
    expect(pending.map((p) => p.requestId).sort((a, b) => a.localeCompare(b))).toEqual([
      "perm-1",
      "perm-2",
    ]);
    expect(pending[0].tool).toBe("bash");

    // Unknown id → 404.
    const bad = await fetch(`${BASE}/permission-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "nope", decision: { kind: "once" } }),
    });
    expect(bad.status).toBe(404);

    // Resolve perm-1 as always → perm-2 (same tool) batch-clears.
    const ok = await fetch(`${BASE}/permission-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "perm-1", decision: { kind: "always" } }),
    });
    expect(ok.status).toBe(200);

    await until(() =>
      events.filter((e) => e.type === "permission_resolved").length === 2 ? true : undefined,
    );
    const resolvedIds = events
      .filter((e) => e.type === "permission_resolved")
      .map((e) => e.requestId ?? "")
      .sort((a, b) => a.localeCompare(b));
    expect(resolvedIds).toEqual(["perm-1", "perm-2"]);

    // Nothing left pending.
    const after = (await getJson<PendingBody>(`${BASE}/pending-permissions`)).data.pending;
    expect(after).toHaveLength(0);

    promptAc.abort();
    ac.abort();
  }, 20_000);
});
