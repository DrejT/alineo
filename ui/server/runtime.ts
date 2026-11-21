/**
 * Real sandbox runtime for the control plane. Every sandbox the dashboard shows is a real
 * OpenSandbox container created through the Alineo SDK (`@alineo-labs/sandbox`).
 * SQLite (`db.ts`) is only the dashboard's index and audit ledger.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { Alineo } from "alineo";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { resolveModel } from "./models";

const DATA_DIR = process.env.ALINEO_UI_DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

// 127.0.0.1, not "localhost": OpenSandbox listens on IPv4 only.
export const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL ?? "http://127.0.0.1:8080";
export const SANDBOX_IMAGE = process.env.ALINEO_UI_SANDBOX_IMAGE ?? "node:22";
export const MAX_SANDBOXES = Number(process.env.ALINEO_UI_MAX_SANDBOXES ?? 8);
export const SANDBOX_TIMEOUT_SECONDS = Number(process.env.ALINEO_UI_SANDBOX_TIMEOUT ?? 60 * 60 * 4);
export const EXEC_TIMEOUT_MS = Number(process.env.ALINEO_UI_EXEC_TIMEOUT_MS ?? 120_000);

const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const adapter = new SQLiteAdapter(join(DATA_DIR, "sdk-ledger.db"));

const client = new Sandbox({
  baseUrl: OPENSANDBOX_URL,
  apiKey: process.env.OPENSANDBOX_API_KEY ?? "",
  // A bare local OpenSandbox hands out container-internal endpoints, so proxy through the server.
  useServerProxy: USE_SERVER_PROXY,
  adapter,
});

/** Live handles, keyed by OpenSandbox sandbox id (also the dashboard's sandbox id). */
const handles = new Map<string, SandboxHandle>();

export async function createHandle(opts: { cpuMilli: number; memMi: number; name: string }): Promise<SandboxHandle> {
  if (handles.size >= MAX_SANDBOXES) {
    throw new Error(`Sandbox limit reached (${MAX_SANDBOXES}). Terminate one first.`);
  }
  const sb = await client.sandbox({
    image: SANDBOX_IMAGE,
    resources: { cpu: `${opts.cpuMilli}m`, memory: `${opts.memMi}Mi` },
    name: opts.name,
    timeout: SANDBOX_TIMEOUT_SECONDS,
  });
  handles.set(sb.sandboxId, sb);
  return sb;
}

export function trackHandle(sb: SandboxHandle): void {
  handles.set(sb.sandboxId, sb);
}

export function dropHandle(id: string): void {
  handles.delete(id);
}

/** Return the live handle, or reconnect to the container if this server process restarted. */
export async function getHandle(id: string, name = id): Promise<SandboxHandle> {
  const known = handles.get(id);
  if (known) return known;
  const sb = await client.connect(id, name, { allowPaused: true });
  handles.set(id, sb);
  return sb;
}

export async function withTimeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Agents: a Pi agent running inside its own sandbox, driven by an NVIDIA NIM model.
// ---------------------------------------------------------------------------

/** Agents need a model key. Without one every sandbox stays a plain container. */
export const AGENTS_ENABLED = Boolean(process.env.NVIDIA_API_KEY) && process.env.ALINEO_UI_AGENTS !== "off";

// An explicit config, so Alineo.start() never depends on the working directory or ~/.config.
const agentConfig = loadProjectConfig({
  discover: false,
  overrides: {
    serverUrl: OPENSANDBOX_URL,
    apiKey: process.env.OPENSANDBOX_API_KEY ?? "",
    useServerProxy: USE_SERVER_PROXY,
    adapterPath: join(DATA_DIR, "agent-ledger.db"),
  },
});

/** Pi is pinned: 1.3.0 breaks NVIDIA model ids (see CLAUDE.md "Pin the Pi version"). */
function agentSpec(modelId: string, cpuMilli: number, memMi: number) {
  const model = resolveModel(modelId);
  return {
    // One stable name per model, so the first start builds a snapshot and later starts reuse it.
    name: `dash-${model.id}`,
    harness: "pi",
    harnessVersion: "1.2.0",
    provider: "nvidia",
    model: model.backend,
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: `${cpuMilli}m`, memory: `${memMi}Mi` },
  };
}

/** Live agents, keyed by sandbox id. A prompt turn marks its agent busy. */
const agents = new Map<string, { agent: Alineo; modelId: string; busy: boolean; steered: boolean }>();

export async function startAgent(opts: { modelId: string; cpuMilli: number; memMi: number }): Promise<SandboxHandle> {
  if (!AGENTS_ENABLED) throw new Error("Agents are off: NVIDIA_API_KEY is not set on the server.");
  if (handles.size >= MAX_SANDBOXES) {
    throw new Error(`Sandbox limit reached (${MAX_SANDBOXES}). Terminate one first.`);
  }
  const agent = await Alineo.start(agentSpec(opts.modelId, opts.cpuMilli, opts.memMi), { adapter, config: agentConfig });
  const sb = agent.sandbox;
  handles.set(sb.sandboxId, sb);
  agents.set(sb.sandboxId, { agent, modelId: opts.modelId, busy: false, steered: false });
  return sb;
}

/** The live agent for a sandbox. After a server restart it reconnects to Pi's bridge in the same container. */
export async function getAgent(id: string, modelId: string, cpuMilli: number, memMi: number) {
  const known = agents.get(id);
  if (known) return known;
  if (!AGENTS_ENABLED) throw new Error("Agents are off: NVIDIA_API_KEY is not set on the server.");
  const opts = { adapter, config: agentConfig, spec: agentSpec(modelId, cpuMilli, memMi) };
  // Reattach keeps Pi's bridge, and any turn still running, alive. Resume restarts the bridge and
  // is the fallback for a bridge that died.
  const agent = await Alineo.reattach(id, opts).catch(() => Alineo.resume(id, opts));
  const entry = { agent, modelId, busy: false, steered: false };
  agents.set(id, entry);
  handles.set(id, agent.sandbox);
  return entry;
}

export function peekAgent(id: string) {
  return agents.get(id);
}

export async function closeAgent(id: string): Promise<void> {
  const a = agents.get(id);
  agents.delete(id);
  if (a) await a.agent.close().catch(() => {});
}
