/**
 * Real sandbox runtime for the control plane. Every sandbox the dashboard shows is a real
 * OpenSandbox container created through the Alineo SDK (`@alineo-labs/sandbox`).
 * SQLite (`db.ts`) is only the dashboard's index and audit ledger.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const DATA_DIR = process.env.ALINEO_UI_DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

// 127.0.0.1, not "localhost": OpenSandbox listens on IPv4 only.
export const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL ?? "http://127.0.0.1:8080";
export const SANDBOX_IMAGE = process.env.ALINEO_UI_SANDBOX_IMAGE ?? "node:22";
export const MAX_SANDBOXES = Number(process.env.ALINEO_UI_MAX_SANDBOXES ?? 8);
export const SANDBOX_TIMEOUT_SECONDS = Number(process.env.ALINEO_UI_SANDBOX_TIMEOUT ?? 60 * 60 * 4);
export const EXEC_TIMEOUT_MS = Number(process.env.ALINEO_UI_EXEC_TIMEOUT_MS ?? 120_000);

const client = new Sandbox({
  baseUrl: OPENSANDBOX_URL,
  apiKey: process.env.OPENSANDBOX_API_KEY ?? "",
  // A bare local OpenSandbox hands out container-internal endpoints, so proxy through the server.
  useServerProxy: process.env.OPEN_SANDBOX_SERVER_PROXY !== "false",
  adapter: new SQLiteAdapter(join(DATA_DIR, "sdk-ledger.db")),
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
