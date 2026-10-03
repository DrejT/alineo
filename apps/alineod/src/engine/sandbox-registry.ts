/**
 * The raw-sandbox subsystem's live state — separate from `registry.ts`'s Pi-agent map.
 *
 * A "sandbox" here is a plain `@alineo-labs/sandbox` container, not a Pi-driven `Alineo`
 * agent — this backs the dashboard's Sandboxes surface (create/exec/checkpoint/fork/close),
 * distinct from Sessions/Swarms (the agent subsystem in `registry.ts`/`spawn.ts`/`stream.ts`).
 *
 * Shares the one SDK ledger adapter (`sdkAdapter`) with the agent subsystem — both are
 * `IStorageAdapter` writers against the same substrate ledger, so `GET /sandboxes` sees agent
 * sandboxes too (an agent's sandboxId is a sandbox like any other to this ledger).
 */
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { sdkAdapter } from "./registry";
import { recallResources } from "../state/sandbox-resources";

const projectConfig = loadProjectConfig({ cwd: process.cwd() });

export const client = new Sandbox({
  baseUrl: projectConfig.serverUrl,
  apiKey: projectConfig.apiKey,
  adapter: sdkAdapter,
  useServerProxy: projectConfig.useServerProxy,
});

/** Live handles for plain sandboxes, keyed by sandboxId. Rebuilt lazily via `resolveLive()` — a
 *  fresh alineod process has nothing here until a route needs a particular sandbox. */
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
  const all = await sdkAdapter.listAllSandboxDetails();
  return all.find((d) => d.sandboxId === sandboxId) ?? null;
}

/**
 * The live handle for `sandboxId`, reconnecting through the SDK if this process doesn't
 * already hold one — alineod can restart while sandboxes keep running (crash-only design,
 * same posture as the agent subsystem's `rehydrate.ts`). Tries a plain reconnect first
 * (cheaper, no snapshot restore); falls back to `resume()` for a sandbox that's paused or
 * otherwise not reachable by `connect()` alone. Throws if the sandbox is unknown to the ledger.
 */
export async function resolveLive(sandboxId: string): Promise<SandboxHandle> {
  const cached = live.get(sandboxId);
  if (cached) return cached;

  const details = await findSandboxDetails(sandboxId);
  if (!details) throw new Error(`no sandbox ${sandboxId}`);

  // Without `resources`, `connect()` doesn't wire up `.fork()` at all (it has no ledger lookup
  // of its own — see its doc comment) — pass along whatever this alineod instance remembers
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
