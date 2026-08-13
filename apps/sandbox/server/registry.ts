import { Alineo, SandboxStatus, type Sandbox } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { Agent } from "@alineo-labs/agent";
import * as config from "./config";

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

const adapter = new SQLiteAdapter(config.LEDGER_PATH);

export const client = new Alineo({
  baseUrl: config.OPENSANDBOX_URL,
  apiKey: config.OPENSANDBOX_API_KEY,
  adapter,
  useServerProxy: config.USE_SERVER_PROXY,
  maxConcurrency: config.MAX_SANDBOXES,
});

/** Live handles for plain sandboxes, keyed by sandboxId. */
export const sandboxes = new Map<string, Sandbox>();
/** Live handles for Pi agents, keyed by sandboxId (an agent's sandboxId IS its id here). */
export const agents = new Map<string, Agent>();

function isAllowedAgentSpec(name: string): name is config.AllowedAgentSpec {
  return (config.ALLOWED_AGENT_SPECS as readonly string[]).includes(name);
}

export async function createSandbox(): Promise<Sandbox> {
  if (sandboxes.size >= config.MAX_SANDBOXES) {
    throw new CapacityError(`Sandbox limit reached (${config.MAX_SANDBOXES})`);
  }
  const sb = await client.sandbox({
    image: config.SANDBOX_IMAGE,
    resources: config.SANDBOX_RESOURCES,
    name: `plain-${crypto.randomUUID().slice(0, 8)}`,
    timeout: config.SANDBOX_TIMEOUT_SECONDS,
  });
  sandboxes.set(sb.sandboxId, sb);
  return sb;
}

export async function deleteSandbox(id: string): Promise<void> {
  const sb = sandboxes.get(id);
  if (!sb) throw new NotFoundError(`Unknown sandbox ${id}`);
  await sb.close();
  sandboxes.delete(id);
}

export async function createAgent(specName: string): Promise<Agent> {
  if (agents.size >= config.MAX_AGENTS) {
    throw new CapacityError(`Agent limit reached (${config.MAX_AGENTS})`);
  }
  if (!isAllowedAgentSpec(specName)) {
    throw new NotFoundError(`Unknown agent spec "${specName}"`);
  }
  const agent = await Agent.load(`${config.AGENTS_DIR}/${specName}.json`, { adapter });
  agents.set(agent.sandboxId, agent);
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const agent = agents.get(id);
  if (!agent) throw new NotFoundError(`Unknown agent ${id}`);
  await agent.close();
  agents.delete(id);
}

/**
 * Rebuild the in-memory registries from the ledger on boot, so a backend
 * restart never leaves running containers orphaned/untracked. Agent sandboxes
 * are identified by ledger `name` matching an allowed spec name (`Agent.load()`
 * names the sandbox after `spec.name`) — `SandboxOptions.metadata` is not
 * surfaced back through `SandboxDetails`, so it can't be used for this.
 */
export async function reconcile(): Promise<void> {
  const records = await client.sandboxes.list({ status: SandboxStatus.Running });
  for (const record of records) {
    try {
      if (isAllowedAgentSpec(record.name)) {
        const agent = await Agent.resume(record.sandboxId, {
          adapter,
          specPath: `${config.AGENTS_DIR}/${record.name}.json`,
        });
        agents.set(agent.sandboxId, agent);
      } else {
        const sb = await client.connect(record.sandboxId, record.name);
        sandboxes.set(sb.sandboxId, sb);
      }
    } catch (err) {
      console.error(`[reconcile] failed to reattach ${record.sandboxId} (${record.name}):`, err);
    }
  }
  console.log(`[reconcile] reattached ${sandboxes.size} sandbox(es), ${agents.size} agent(s)`);
}
