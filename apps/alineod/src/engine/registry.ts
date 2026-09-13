/**
 * The live `Alineo` handles, in process memory, keyed by alineod's `agentId`.
 *
 * This map is intentionally NOT durable — it's rebuilt by rehydrate.ts from the projection +
 * `Alineo.resume()` on boot. The durable truth is the ledger; this is just the open
 * connections (research/daemon.md §3, crash-only).
 */
import type { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { SDK_LEDGER_PATH } from "../../config";

const agents = new Map<string, Alineo>();

/** One shared SDK ledger adapter for every `Alineo.load()` / `.resume()` alineod makes. */
export const sdkAdapter = new SQLiteAdapter(SDK_LEDGER_PATH);

export async function connectSdkAdapter(): Promise<void> {
  await sdkAdapter.connect?.();
}

export function register(agentId: string, agent: Alineo): void {
  agents.set(agentId, agent);
}

export function get(agentId: string): Alineo | undefined {
  return agents.get(agentId);
}

export function forget(agentId: string): void {
  agents.delete(agentId);
}

export function has(agentId: string): boolean {
  return agents.has(agentId);
}
