import { Alineo, SandboxStatus, type SandboxDetails } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { ControlClient, SandboxState } from "@alineo-labs/opensandbox";
import { readConfig, type AlineoConfig } from "./config.js";

export interface SessionSnapshot {
  tracked: SandboxDetails[];
  /** Sandbox IDs running in OpenSandbox but with no ledger record (e.g. agent-spawned children). */
  untracked: string[];
}

/**
 * Data layer shared by `alineo ps` and the TUI dashboard: alineo-tracked running
 * sessions from the ledger, merged with raw OpenSandbox sandboxes the ledger
 * never recorded.
 *
 * The ledger only learns a sandbox stopped when its own `close()` call runs
 * and emits `sandbox_closed` — an ungraceful death (a crash, OpenSandbox's
 * own TTL expiring the container, someone deleting it outside alineo entirely)
 * leaves a "Running" ledger row forever, since nothing ever told it
 * otherwise. Every ledger-"Running" entry is cross-checked here against the
 * live OpenSandbox control plane — the actual source of truth — and dropped
 * if the control plane no longer has it Running.
 */
export async function getSessions(config?: AlineoConfig): Promise<SessionSnapshot> {
  const cfg = config ?? (await readConfig());
  const adapter = new SQLiteAdapter(cfg.adapterPath);
  const client = new Alineo({
    baseUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    adapter,
    useServerProxy: cfg.useServerProxy,
  });

  const ledgerRunning = await client.sandboxes.list({ status: SandboxStatus.Running });

  const control = new ControlClient({ baseUrl: cfg.serverUrl, apiKey: cfg.apiKey });
  let liveIds: Set<string> | null = null;
  try {
    const raw = await control.listSandboxes({ state: SandboxState.Running });
    liveIds = new Set(raw.map((s) => s.id));
  } catch {
    // Control-plane listing is best-effort; fall back to trusting the ledger
    // rather than showing nothing.
  }

  const tracked = liveIds ? ledgerRunning.filter((s) => liveIds!.has(s.sandboxId)) : ledgerRunning;

  const trackedIds = new Set(tracked.map((s) => s.sandboxId));
  const untracked = liveIds ? [...liveIds].filter((id) => !trackedIds.has(id)) : [];

  return { tracked, untracked };
}

export function formatAge(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
