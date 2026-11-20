import { listSandboxes, spawnSandbox, forkSandbox, checkpointSandbox, pauseSandbox, resumeSandbox } from "./sandboxes";
import { recallSemanticFacts, setWorkingMemory, compactMemory } from "./memory";
import { decideEgressGate } from "./security";
import { flushWorkflowPipeline } from "./workflow";
import { steerAgent } from "./steer";

export interface CliExecutionResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

export async function executeOneCliCommand(userId: string, rawCmd: string): Promise<CliExecutionResult> {
  const start = performance.now();
  const trimmed = rawCmd.trim();

  let output = '';
  let exitCode = 0;

  try {
    if (trimmed === 'bunx alineo-cli init' || trimmed === 'alineo init') {
      output = `✓ Connected to OpenSandbox control substrate
✓ Loaded @alineo-labs/sqlite WAL adapter at data/control-plane.db
✓ Initialized user memory partitions (working_memory, episodic_memory, semantic_facts)
✓ Alineo daemon listening on 127.0.0.1:4600 (HTTP + SSE)
✓ Ready. Run 'alineo spawn --role <role>' to deploy your first isolated agent.`;
    } else if (trimmed === 'alineo status' || trimmed === 'alineo fleet') {
      const sandboxes = listSandboxes(userId);
      output = `Alineo Swarm Fleet Status (User: ${userId}):
  Daemon: ONLINE (127.0.0.1:4600)
  Storage: SQLiteAdapter (Local WAL)
  Active Sandboxes (${sandboxes.length}):
` + sandboxes.map(s => `    - [${s.id}] ${s.role.padEnd(20)} ${s.status.toUpperCase().padEnd(8)} CPU: ${s.cpuCurrentMilli}/${s.cpuLimitMilli}m  RAM: ${s.memCurrentMi}/${s.memLimitMi}Mi  Checkpoint: ${s.checkpointId || 'none'}`).join('\n');
    } else if (trimmed.startsWith('alineo spawn')) {
      const roleMatch = trimmed.match(/--role\s+([^\s]+)/);
      const cpuMatch = trimmed.match(/--cpu\s+([^\s]+)/);
      const memMatch = trimmed.match(/--mem\s+([^\s]+)/);

      const role = roleMatch ? roleMatch[1] : 'agent-worker';
      const cpu = cpuMatch ? parseInt(cpuMatch[1], 10) : 500;
      const mem = memMatch ? parseInt(memMatch[1], 10) : 512;

      const sb = await spawnSandbox(userId, { role, cpuLimitMilli: cpu, memLimitMi: mem });
      output = `✓ Provisioned sandbox container ${sb.id} (${sb.role})
  PID: ${sb.pid}
  Allocated: ${sb.cpuLimitMilli}m CPU / ${sb.memLimitMi}Mi RAM
  Initial Checkpoint: ${sb.checkpointId}
  State: RUNNING`;
    } else if (trimmed.startsWith('alineo fork')) {
      const parts = trimmed.split(/\s+/);
      const parentId = parts[2];
      if (!parentId) throw new Error("Missing parent sandbox ID: alineo fork <sandboxId>");
      const roleMatch = trimmed.match(/--role\s+([^\s]+)/);
      const child = await forkSandbox(userId, parentId, roleMatch ? roleMatch[1] : undefined);
      output = `✓ Forked child container ${child.id} (${child.role})
  Parent: ${parentId}@${child.checkpointId}
  Inherited Copy-on-Write overlay active.`;
    } else if (trimmed.startsWith('alineo checkpoint')) {
      const parts = trimmed.split(/\s+/);
      const targetId = parts[2];
      if (!targetId) throw new Error("Missing sandbox ID: alineo checkpoint <sandboxId>");
      const tagMatch = trimmed.match(/--tag\s+([^\s]+)/);
      const cp = await checkpointSandbox(userId, targetId, tagMatch ? tagMatch[1] : undefined);
      output = `✓ Committed immutable snapshot ${cp} for sandbox ${targetId} to SQLite ledger.`;
    } else if (trimmed.startsWith('alineo pause')) {
      const parts = trimmed.split(/\s+/);
      const targetId = parts[2];
      if (!targetId) throw new Error("Missing sandbox ID: alineo pause <sandboxId>");
      await pauseSandbox(userId, targetId);
      output = `✓ Paused sandbox ${targetId}.`;
    } else if (trimmed.startsWith('alineo resume')) {
      const parts = trimmed.split(/\s+/);
      const targetId = parts[2];
      if (!targetId) throw new Error("Missing sandbox ID: alineo resume <sandboxId>");
      await resumeSandbox(userId, targetId);
      output = `✓ Resumed sandbox ${targetId}.`;
    } else if (trimmed.startsWith('alineo steer')) {
      const targetMatch = trimmed.match(/alineo\s+steer\s+([^\s]+)\s+"([^"]+)"/);
      if (!targetMatch) throw new Error('Invalid syntax: alineo steer <sandboxId> "<directive>" [--scope <node|subtree|fleet>]');
      const targetId = targetMatch[1];
      const directive = targetMatch[2];
      const scopeMatch = trimmed.match(/--scope\s+(node|subtree|fleet)/);
      const scope = (scopeMatch ? scopeMatch[1] : 'node') as 'node' | 'subtree' | 'fleet';

      const res = steerAgent(userId, targetId, directive, scope);
      output = `✓ Delivered steering directive to ${res.affectedSandboxIds.length} sandbox node(s) (scope=${scope}):
  Target: ${targetId}
  Directive: "${directive}"
  Affected: ${res.affectedSandboxIds.join(', ')}`;
    } else if (trimmed.startsWith('alineo memory recall')) {
      const queryMatch = trimmed.match(/recall\s+"?([^"]+)"?/);
      const queryStr = queryMatch ? queryMatch[1] : '';
      const facts = recallSemanticFacts(userId, queryStr, 5);
      output = `Recall results for query "${queryStr}" (${facts.length} facts):\n` +
        facts.map(f => `  [score: ${f.score ?? 'N/A'}] (${f.subject}) -[${f.predicate}]-> (${f.object})  tags: [${f.tags.join(', ')}]`).join('\n');
    } else if (trimmed.startsWith('alineo memory set')) {
      const parts = trimmed.split(/\s+/);
      const targetId = parts[3];
      const key = parts[4];
      const val = parts[5];
      if (!targetId || !key || !val) throw new Error("Usage: alineo memory set <sandboxId> <key> <val>");
      setWorkingMemory(userId, targetId, key, val);
      output = `✓ Saved working memory ${targetId}[${key}] = "${val}"`;
    } else if (trimmed === 'alineo memory compact') {
      const res = compactMemory(userId);
      output = `✓ Memory compaction completed:
  Pruned Episodes: ${res.prunedEpisodes}
  Pruned Facts: ${res.prunedFacts}
  Freed Bytes: ${res.freedBytes} B`;
    } else if (trimmed.startsWith('alineo egress approve')) {
      const parts = trimmed.split(/\s+/);
      const gateId = parts[3];
      if (!gateId) throw new Error("Usage: alineo egress approve <gateId>");
      const g = await decideEgressGate(userId, gateId, 'allowed');
      output = `✓ Approved outbound egress gate ${gateId} to ${g?.targetHost}. Sandbox resumed.`;
    } else if (trimmed.startsWith('alineo egress deny')) {
      const parts = trimmed.split(/\s+/);
      const gateId = parts[3];
      if (!gateId) throw new Error("Usage: alineo egress deny <gateId>");
      const g = await decideEgressGate(userId, gateId, 'denied');
      output = `✓ Denied outbound egress gate ${gateId} to ${g?.targetHost}.`;
    } else if (trimmed === 'alineo workflow flush') {
      const res = flushWorkflowPipeline(userId);
      output = `✓ Flushed pipeline: completed ${res.flushedCount} tasks across semaphore slots.`;
    } else {
      output = `Unknown alineo command: "${trimmed}". Available commands:
  alineo init
  alineo status
  alineo spawn --role <role> [--cpu <cpu>] [--mem <mem>]
  alineo fork <sandboxId> [--role <role>]
  alineo checkpoint <sandboxId> [--tag <tag>]
  alineo pause <sandboxId> / resume <sandboxId>
  alineo steer <sandboxId> "<directive>" [--scope <node|subtree|fleet>]
  alineo memory recall "<query>"
  alineo memory set <sandboxId> <key> <val>
  alineo memory compact
  alineo egress approve <gateId> / deny <gateId>
  alineo workflow flush`;
      exitCode = 1;
    }
  } catch (err: any) {
    output = `Error: ${err.message || String(err)}`;
    exitCode = 1;
  }

  const durationMs = Math.round(performance.now() - start);
  return {
    command: rawCmd,
    exitCode,
    output,
    durationMs,
  };
}
