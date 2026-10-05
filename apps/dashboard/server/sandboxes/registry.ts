/**
 * The raw-sandbox subsystem's live state. A "sandbox" here is a plain `@alineo-labs/sandbox`
 * container this server created, not a Pi agent (those live in alineod).
 *
 * Writes to this server's own ledger (`../ledger`), so `GET /sandboxes` lists the sandboxes the
 * dashboard created. Sandboxes made by alineod agents are reached through alineod's own routes.
 */
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { ledger } from "../ledger";
import { recallResources } from "./resources";

const projectConfig = loadProjectConfig({ cwd: process.cwd() });

export const client = new Sandbox({
  baseUrl: projectConfig.serverUrl,
  apiKey: projectConfig.apiKey,
  adapter: ledger,
  useServerProxy: projectConfig.useServerProxy,
});

/** Live handles for plain sandboxes, keyed by sandboxId. Rebuilt lazily via `resolveLive()` — a
 *  fresh process has nothing here until a route needs a particular sandbox. */
const live = new Map<string, SandboxHandle>();

export function register(sb: SandboxHandle): void {
  live.set(sb.sandboxId, sb);
}

export function peek(sandboxId: string): SandboxHandle | undefined {
  return live.get(sandboxId);
}

export function forget(sandboxId: string): void {
  live.delete(sandboxId);
}

/** `IStorageAdapter.getSandboxDetails` takes `(name, sandboxId)` — a dashboard route only ever
 *  has the id, so this finds the matching row by scanning the (typically small) full list. */
export async function findSandboxDetails(sandboxId: string) {
  const all = await ledger.listAllSandboxDetails();
  return all.find((d) => d.sandboxId === sandboxId) ?? null;
}

/**
 * The live handle for `sandboxId`, reconnecting through the SDK if this process doesn't
 * already hold one — this server can restart while sandboxes keep running. Tries a plain reconnect first
 * (cheaper, no snapshot restore); falls back to `resume()` for a sandbox that's paused or
 * otherwise not reachable by `connect()` alone. Throws if the sandbox is unknown to the ledger.
 */
export async function resolveLive(sandboxId: string): Promise<SandboxHandle> {
  const cached = live.get(sandboxId);
  if (cached) return cached;

  const details = await findSandboxDetails(sandboxId);
  if (!details) throw new Error(`no sandbox ${sandboxId}`);

  // Without `resources`, `connect()` doesn't wire up `.fork()` at all (it has no ledger lookup
  // of its own — see its doc comment) — pass along whatever this server remembers
  // creating this sandbox with, so a sandbox reconnected after a restart keeps fork support.
  const resources = recallResources(sandboxId) ?? undefined;

  try {
    const sb = await client.connect(sandboxId, details.name, { allowPaused: true, resources });
    register(sb);
    return sb;
  } catch {
    const sb = await client.resume(sandboxId);
    register(sb);
    return sb;
  }
}
