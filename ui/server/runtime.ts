/**
 * Real sandbox runtime for the control plane. Every sandbox the dashboard shows is a real
 * OpenSandbox container created through the Alineo SDK (`@alineo-labs/sandbox`).
 * SQLite (`db.ts`) is only the dashboard's index and audit ledger.
 */
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { Alineo, AgentSnapshotStore, computeSetupHash, snapshotsPath } from "alineo";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { resolveModel, scrubText } from "./models";
import { log as slog, clipText, timer } from "./log";

const DATA_DIR = process.env.ALINEO_UI_DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

// 127.0.0.1, not "localhost": OpenSandbox listens on IPv4 only.
export const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL ?? "http://127.0.0.1:8080";
export const SANDBOX_IMAGE = process.env.ALINEO_UI_SANDBOX_IMAGE ?? "node:22";
export const MAX_SANDBOXES = Number(process.env.ALINEO_UI_MAX_SANDBOXES ?? 8);
/** Agents run Pi and Chrome, about 1.5 GB each, so they have their own, lower cap. */
export const MAX_AGENTS = Number(process.env.ALINEO_UI_MAX_AGENTS ?? 3);
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
// Agents: a Pi agent running inside its own sandbox, driven by the model behind each Gemini name (see models.ts).
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

/** Pi's browser tools (browser_open, browser_snapshot, ...). Installed into the agent image, not read at run time. */
const BROWSER_EXTENSION = readFileSync(join(import.meta.dir, "..", "..", "packages", "agent-browser", "pi-extension", "agent-browser.ts"), "utf8");
const EXTENSIONS_DIR = "/root/.pi/agent/extensions";

/**
 * Everything an agent needs, installed once into a cached snapshot: Pi, Chrome with its system
 * libraries, the agent-browser CLI, and the Pi extension that turns it into tools. The snapshot is
 * keyed by this list, so changing a step rebuilds it once. Models are not part of the key.
 */
// Chrome's system libraries. The package's own setup step installs these at the same time as agent-browser,
// and both run apt, so they can fail on the package lock. Run one after the other.
const CHROME_LIBS =
  "libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 " +
  "libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 " +
  "libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 " +
  "libcups2 libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf";

const AGENT_SETUP = [
  { name: "Install Chrome's system libraries", run: `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${CHROME_LIBS}` },
  { name: "Install the agent-browser CLI", run: "npm install -g agent-browser" },
  { name: "Download Chrome", run: "agent-browser install" },
  {
    name: "Install the browser tools extension for Pi",
    run:
      `mkdir -p ${EXTENSIONS_DIR} && cd ${EXTENSIONS_DIR} && npm init -y >/dev/null && npm install typebox@^1.3.5 >/dev/null 2>&1 && ` +
      `cat > agent-browser.ts <<'ALINEO_EXT_EOF'\n${BROWSER_EXTENSION}\nALINEO_EXT_EOF`,
  },
];

/** Pi is pinned: 1.3.0 breaks NVIDIA model ids (see CLAUDE.md "Pin the Pi version"). */
function agentSpec(modelId: string, cpuMilli: number, memMi: number) {
  const model = resolveModel(modelId);
  return {
    // One name for every model. The model is written into Pi's config on each start, after the
    // snapshot is restored, so a single cached image serves all of them.
    name: "dash-agent",
    harness: "pi",
    harnessVersion: "1.2.0",
    provider: "nvidia",
    model: model.backend,
    setup: AGENT_SETUP,
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: `${cpuMilli}m`, memory: `${memMi}Mi` },
  };
}

// ---------------------------------------------------------------------------
// The agent image: a cached snapshot with Pi, Chrome and the browser tools already installed.
// ---------------------------------------------------------------------------
export type ImageState = { state: "off" | "missing" | "building" | "ready" | "error"; detail?: string; builtAt?: number };
let building: Promise<void> | null = null;
let buildError: string | undefined;

/** Is the snapshot for the current setup already cached on this host? */
export async function agentImage(): Promise<ImageState> {
  if (!AGENTS_ENABLED) return { state: "off" };
  if (building) return { state: "building" };
  if (buildError) return { state: "error", detail: scrubText(buildError) };
  const spec = agentSpec("gemini-3.8-flash", 1000, 1536);
  const rec = await new AgentSnapshotStore(snapshotsPath(agentConfig.adapterPath)).get(spec.name, computeSetupHash(spec as never));
  return rec ? { state: "ready", builtAt: rec.createdAt } : { state: "missing" };
}

/**
 * Make sure the cached image exists. If it does not, build it now: start one agent, which installs
 * everything and checkpoints, then close it. Safe to call often. Runs at most one build at a time.
 */
export function warmAgentImage(): Promise<void> {
  if (!AGENTS_ENABLED) return Promise.resolve();
  if (building) return building;
  building = (async () => {
    if ((await agentImage()).state === "ready") return;
    buildError = undefined;
    const elapsed = timer();
    slog("info", "image.build.start", {}, true);
    const agent = await Alineo.start(agentSpec("gemini-3.8-flash", 1000, 1536), { adapter, config: agentConfig });
    await agent.close().catch(() => {});
    slog("info", "image.build.end", { ms: elapsed() }, true);
  })()
    .catch((err) => { buildError = err instanceof Error ? err.message : String(err); slog("error", "image.build.error", { error: clipText(buildError, 500) }, true); })
    .finally(() => { building = null; });
  return building;
}

/** Live agents, keyed by sandbox id. A prompt turn marks its agent busy. */
const agents = new Map<string, { agent: Alineo; modelId: string; busy: boolean; steered: boolean }>();

export async function startAgent(opts: { modelId: string; cpuMilli: number; memMi: number }): Promise<SandboxHandle> {
  if (!AGENTS_ENABLED) throw new Error("Agents are not enabled on this server.");
  if (handles.size >= MAX_SANDBOXES) {
    throw new Error(`Sandbox limit reached (${MAX_SANDBOXES}). Terminate one first.`);
  }
  if (agents.size >= MAX_AGENTS) {
    throw new Error(`Agent limit reached (${MAX_AGENTS} at a time). Stop a goal or terminate an agent first.`);
  }
  // Build the cached image first if it is missing. Starting two agents on an empty cache would build it twice.
  await warmAgentImage();
  if (buildError) throw new Error(`The agent image could not be built: ${scrubText(buildError)}`);
  const elapsed = timer();
  const agent = await Alineo.start(agentSpec(opts.modelId, opts.cpuMilli, opts.memMi), { adapter, config: agentConfig });
  const sb = agent.sandbox;
  slog("info", "agent.start", { sandbox: sb.sandboxId, model: opts.modelId, ms: elapsed(), agentsAlive: agents.size + 1 }, true);
  handles.set(sb.sandboxId, sb);
  agents.set(sb.sandboxId, { agent, modelId: opts.modelId, busy: false, steered: false });
  return sb;
}

/** The live agent for a sandbox. After a server restart it reconnects to Pi's bridge in the same container. */
export async function getAgent(id: string, modelId: string, cpuMilli: number, memMi: number) {
  const known = agents.get(id);
  if (known) return known;
  if (!AGENTS_ENABLED) throw new Error("Agents are not enabled on this server.");
  const opts = { adapter, config: agentConfig, spec: agentSpec(modelId, cpuMilli, memMi) };
  // Reattach keeps Pi's bridge, and any turn still running, alive. Resume restarts the bridge and
  // is the fallback for a bridge that died.
  let how = "reattach";
  const agent = await Alineo.reattach(id, opts).catch(() => { how = "resume"; return Alineo.resume(id, opts); });
  slog("info", "agent.reconnect", { sandbox: id, how }, true);
  const entry = { agent, modelId, busy: false, steered: false };
  agents.set(id, entry);
  handles.set(id, agent.sandbox);
  return entry;
}

/** How many agents are alive right now. */
export function agentCount(): number {
  return agents.size;
}

export function peekAgent(id: string) {
  return agents.get(id);
}

export async function closeAgent(id: string): Promise<void> {
  const a = agents.get(id);
  agents.delete(id);
  if (a) await a.agent.close().catch(() => {});
}
