import { db } from "./db";
import { createHandle, getHandle, trackHandle, dropHandle, withTimeout, SANDBOX_IMAGE, EXEC_TIMEOUT_MS } from "./runtime";

export interface SandboxRecord {
  id: string;
  userId: string;
  role: string;
  status: 'running' | 'paused' | 'terminated';
  parentId: string | null;
  depth: number;
  uptime: string;
  uptimeStart: number;
  egressPolicy: string;
  cpuLimitMilli: number;
  memLimitMi: number;
  cpuCurrentMilli: number;
  memCurrentMi: number;
  pid: number;
  checkpointId: string | null;
  checkpointAgo: string;
  checkpointTs: number | null;
  mcpTools: string[];
  modelProvider: string;
  summary: string;
  recentExecs: Array<{ cmd: string; exit: number | string; dur: string; ts: string }>;
  logs: Array<{ type: string; text: string }>;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min === 0) return `${remSec}s`;
  return `${min}m ${remSec.toString().padStart(2, '0')}s`;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3600_000)}h ago`;
}

export function listSandboxes(userId = 'usr_test'): SandboxRecord[] {
  const rows = db.query(`SELECT * FROM sandboxes WHERE user_id = ? AND status != 'terminated' ORDER BY depth ASC, uptime_start ASC`).all(userId) as any[];
  const now = Date.now();

  return rows.map((row) => {
    const logs = db.query(`SELECT type, text FROM sandbox_logs WHERE user_id = ? AND sandbox_id = ? ORDER BY ts ASC LIMIT 50`).all(userId, row.id) as any[];
    const execs = db.query(`SELECT cmd, exit_code, duration_ms, ts FROM sandbox_execs WHERE user_id = ? AND sandbox_id = ? ORDER BY ts DESC LIMIT 10`).all(userId, row.id) as any[];

    return {
      id: row.id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      parentId: row.parent_id,
      depth: row.depth,
      uptime: formatDuration(now - row.uptime_start),
      uptimeStart: row.uptime_start,
      egressPolicy: row.egress_policy,
      cpuLimitMilli: row.cpu_limit_milli,
      memLimitMi: row.mem_limit_mi,
      cpuCurrentMilli: row.cpu_current_milli,
      memCurrentMi: row.mem_current_mi,
      pid: row.pid,
      checkpointId: row.checkpoint_id,
      checkpointAgo: timeAgo(row.checkpoint_ts),
      checkpointTs: row.checkpoint_ts,
      mcpTools: JSON.parse(row.mcp_tools || '[]'),
      modelProvider: row.model_provider || 'gemini-3.8-flash',
      summary: row.summary,
      recentExecs: execs.map(e => ({
        cmd: e.cmd,
        exit: e.exit_code,
        dur: `${e.duration_ms}ms`,
        ts: new Date(e.ts).toTimeString().split(' ')[0],
      })),
      logs: logs.map(l => ({ type: l.type, text: l.text })),
    };
  });
}

export function getSandbox(userId: string, id: string): SandboxRecord | null {
  const row = db.query(`SELECT * FROM sandboxes WHERE user_id = ? AND id = ?`).get(userId, id) as any;
  if (!row) return null;

  const now = Date.now();
  const logs = db.query(`SELECT type, text FROM sandbox_logs WHERE user_id = ? AND sandbox_id = ? ORDER BY ts ASC`).all(userId, row.id) as any[];
  const execs = db.query(`SELECT cmd, exit_code, duration_ms, ts FROM sandbox_execs WHERE user_id = ? AND sandbox_id = ? ORDER BY ts DESC LIMIT 20`).all(userId, row.id) as any[];

  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    parentId: row.parent_id,
    depth: row.depth,
    uptime: formatDuration(now - row.uptime_start),
    uptimeStart: row.uptime_start,
    egressPolicy: row.egress_policy,
    cpuLimitMilli: row.cpu_limit_milli,
    memLimitMi: row.mem_limit_mi,
    cpuCurrentMilli: row.cpu_current_milli,
    memCurrentMi: row.mem_current_mi,
    pid: row.pid,
    checkpointId: row.checkpoint_id,
    checkpointAgo: timeAgo(row.checkpoint_ts),
    checkpointTs: row.checkpoint_ts,
    mcpTools: JSON.parse(row.mcp_tools || '[]'),
    modelProvider: row.model_provider || 'gemini-3.8-flash',
    summary: row.summary,
    recentExecs: execs.map(e => ({
      cmd: e.cmd,
      exit: e.exit_code,
      dur: `${e.duration_ms}ms`,
      ts: new Date(e.ts).toTimeString().split(' ')[0],
    })),
    logs: logs.map(l => ({ type: l.type, text: l.text })),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle. Every operation acts on a REAL OpenSandbox container through the
// Alineo SDK (see runtime.ts). SQLite below is only the dashboard index + ledger.
// ---------------------------------------------------------------------------

function stamp(ts: number): string {
  return new Date(ts).toISOString().substring(11, 23);
}

function addLog(userId: string, sandboxId: string, type: string, text: string, ts: number): void {
  db.prepare(`INSERT INTO sandbox_logs (user_id, sandbox_id, type, text, ts) VALUES (?, ?, ?, ?, ?)`).run(
    userId, sandboxId, type, `[${stamp(ts)}] ${text}`, ts
  );
}

function addLedger(
  userId: string, ts: number, type: string, sandboxId: string, tool: string,
  detail: string, branch: string, shortLabel: string, payload: unknown
): void {
  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, ts, type, sandboxId, tool, detail, branch, shortLabel, JSON.stringify(payload));
}

function insertSandboxRow(userId: string, row: {
  id: string; role: string; parentId: string | null; depth: number; cpu: number; mem: number;
  tools: string[]; summary: string; model: string; checkpointId: string | null; egressPolicy?: string;
}, now: number): void {
  db.prepare(`
    INSERT INTO sandboxes (
      id, user_id, role, status, parent_id, depth, uptime_start, egress_policy,
      cpu_limit_milli, mem_limit_mi, cpu_current_milli, mem_current_mi,
      pid, checkpoint_id, checkpoint_ts, mcp_tools, summary, model_provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, userId, row.role, 'running', row.parentId, row.depth, now,
    row.egressPolicy || 'allowlist-enforced', row.cpu, row.mem,
    0, 0, 0, // no live metrics wired yet: show zero, never invented numbers
    row.checkpointId, row.checkpointId ? now : null,
    JSON.stringify(row.tools), row.summary, row.model
  );
}

export async function spawnSandbox(userId: string, params: {
  role: string;
  parentId?: string | null;
  cpuLimitMilli?: number;
  memLimitMi?: number;
  mcpTools?: string[];
  modelProvider?: string;
  summary?: string;
}): Promise<SandboxRecord> {
  const parent = params.parentId ? getSandbox(userId, params.parentId) : null;
  const cpu = params.cpuLimitMilli || 500;
  const mem = params.memLimitMi || 512;
  const role = params.role || 'custom-agent';
  const tools = params.mcpTools && params.mcpTools.length > 0 ? params.mcpTools : ['Filesystem'];
  const model = params.modelProvider || 'gemini-3.8-flash';

  const handle = await createHandle({ cpuMilli: cpu, memMi: mem, name: `${role}-${crypto.randomUUID().slice(0, 6)}` });
  const id = handle.sandboxId;
  const now = Date.now();

  insertSandboxRow(userId, {
    id, role, parentId: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0, cpu, mem, tools,
    summary: params.summary || `OpenSandbox container ${id} (${SANDBOX_IMAGE}, ${cpu}m CPU, ${mem}Mi RAM).`,
    model, checkpointId: null,
  }, now);
  addLog(userId, id, 'exec_start', `sandbox_ready: OpenSandbox ${id} running ${SANDBOX_IMAGE} (${cpu}m CPU / ${mem}Mi RAM)`, now);
  addLedger(userId, now, 'exec_start', id, 'SPAWN', `Spawned sandbox ${id} (${role}) with ${cpu}m CPU / ${mem}Mi RAM`,
    parent ? 'fork' : 'main', `spawn ${role}`, { cpu, mem, image: SANDBOX_IMAGE, parentId: parent?.id, tools });

  return getSandbox(userId, id)!;
}

export async function pauseSandbox(userId: string, id: string): Promise<boolean> {
  const sb = getSandbox(userId, id);
  if (!sb) return false;
  const handle = await getHandle(id, sb.role);
  await handle.pause();
  const now = Date.now();
  db.prepare(`UPDATE sandboxes SET status = 'paused', cpu_current_milli = 0 WHERE user_id = ? AND id = ?`).run(userId, id);
  addLog(userId, id, 'exec_event', `sandbox_paused: container frozen`, now);
  addLedger(userId, now, 'exec_event', id, 'LIFECYCLE', `Paused sandbox container ${id}`,
    sb.parentId ? 'fork' : 'main', 'pause', { status: 'paused' });
  return true;
}

export async function resumeSandbox(userId: string, id: string): Promise<boolean> {
  const sb = getSandbox(userId, id);
  if (!sb) return false;
  const handle = await getHandle(id, sb.role);
  await handle.resume();
  const now = Date.now();
  db.prepare(`UPDATE sandboxes SET status = 'running' WHERE user_id = ? AND id = ?`).run(userId, id);
  addLog(userId, id, 'exec_start', `sandbox_resumed: container unfrozen`, now);
  addLedger(userId, now, 'exec_start', id, 'LIFECYCLE', `Resumed sandbox container ${id}`,
    sb.parentId ? 'fork' : 'main', 'resume', { status: 'running' });
  return true;
}

export async function forkSandbox(userId: string, parentId: string, childRole?: string, modelProvider?: string): Promise<SandboxRecord> {
  const parent = getSandbox(userId, parentId);
  if (!parent) throw new Error(`Parent sandbox ${parentId} not found`);

  const parentHandle = await getHandle(parentId, parent.role);
  const role = childRole || `${parent.role}-fork`;
  // Real fork: snapshots the parent's filesystem and restores it into a new container.
  const child = await parentHandle.fork(role);
  trackHandle(child);
  const childId = child.sandboxId;
  const now = Date.now();

  insertSandboxRow(userId, {
    id: childId, role, parentId: parent.id, depth: parent.depth + 1,
    cpu: parent.cpuLimitMilli, mem: parent.memLimitMi, tools: parent.mcpTools,
    summary: `Forked from ${parent.id}: filesystem snapshot restored into a new container.`,
    model: modelProvider || parent.modelProvider || 'gemini-3.8-flash', checkpointId: null,
  }, now);
  addLog(userId, parent.id, 'exec_event', `fork_spawn: created child sandbox ${childId} (${role})`, now);
  addLog(userId, childId, 'exec_start', `fork_init: restored snapshot of ${parent.id}`, now);
  addLedger(userId, now, 'checkpoint', parent.id, 'FORK', `Forked child sandbox ${childId} (${role}) from ${parent.id}`,
    'fork', 'fork node', { parentId: parent.id, childId });

  return getSandbox(userId, childId)!;
}

export async function checkpointSandbox(userId: string, id: string, tag?: string): Promise<string> {
  const sb = getSandbox(userId, id);
  if (!sb) throw new Error(`Sandbox ${id} not found`);
  const handle = await getHandle(id, sb.role);
  const snapshotId = await handle.checkpoint(tag);
  const now = Date.now();
  db.prepare(`UPDATE sandboxes SET checkpoint_id = ?, checkpoint_ts = ? WHERE user_id = ? AND id = ?`).run(snapshotId, now, userId, id);
  addLog(userId, id, 'exec_complete', `checkpoint_saved: filesystem snapshot ${snapshotId}`, now);
  addLedger(userId, now, 'checkpoint', id, 'CHECKPOINT', `Saved checkpoint ${snapshotId} for sandbox ${id}`,
    sb.parentId ? 'fork' : 'main', 'snapshot', { checkpoint: snapshotId, tag: tag ?? null, ts: now });
  return snapshotId;
}

export async function terminateSandbox(userId: string, id: string): Promise<boolean> {
  const sb = getSandbox(userId, id);
  if (!sb) return false;
  try {
    const handle = await getHandle(id, sb.role);
    await handle.close();
  } catch {
    // The container may already be gone (expired or removed by hand). The record is closed either way.
  }
  dropHandle(id);
  const now = Date.now();
  db.prepare(`UPDATE sandboxes SET status = 'terminated', cpu_current_milli = 0, mem_current_mi = 0 WHERE user_id = ? AND id = ?`).run(userId, id);
  addLedger(userId, now, 'exec_complete', id, 'LIFECYCLE', `Terminated sandbox container ${id}`,
    sb.parentId ? 'fork' : 'main', 'terminate', { status: 'terminated' });
  return true;
}

/** Run a command inside the sandbox container. Nothing ever runs on the host. */
export async function execInSandbox(userId: string, id: string, cmd: string): Promise<{ stdout: string; exitCode: number; durationMs: number }> {
  const sb = getSandbox(userId, id);
  if (!sb) throw new Error(`Sandbox ${id} not found`);
  if (sb.status !== 'running') throw new Error(`Sandbox ${id} is ${sb.status}. Resume it before running commands.`);

  const handle = await getHandle(id, sb.role);
  const start = performance.now();
  const startTs = Date.now();
  let stdout = '';
  let exitCode = 0;
  try {
    const res = await withTimeout(handle.exec(cmd), EXEC_TIMEOUT_MS, `exec "${cmd}"`);
    exitCode = res.exitCode;
    stdout = [res.stdout, res.stderr].filter(Boolean).join(res.stdout && res.stderr ? '\n' : '') || `exit_code=${exitCode}`;
  } catch (err) {
    // The SDK throws CommandError for any non-zero exit. That is a normal result (grep with no match,
    // a failing test run), so return the command's own exit code and output instead of an error string.
    const e = err as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof e.exitCode === 'number' && typeof e.stdout === 'string') {
      exitCode = e.exitCode;
      stdout = [e.stdout, typeof e.stderr === 'string' ? e.stderr : ''].filter(Boolean).join(e.stdout && e.stderr ? '\n' : '') || `exit_code=${exitCode}`;
    } else {
      // A real failure to run the command: timeout, sandbox gone, execd unreachable.
      exitCode = 1;
      stdout = `[exec error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const durationMs = Math.round(performance.now() - start);

  db.prepare(`INSERT INTO sandbox_execs (user_id, sandbox_id, cmd, exit_code, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?)`).run(
    userId, id, cmd, exitCode, durationMs, startTs
  );
  addLog(userId, id, 'exec_start', `$ ${cmd}`, startTs);
  addLog(userId, id, 'exec_complete', stdout.split('\n')[0].slice(0, 200), startTs + durationMs);
  addLedger(userId, startTs, 'exec_complete', id, 'SHELL', `Executed "${cmd}" inside ${id} (duration=${durationMs}ms)`,
    sb.parentId ? 'fork' : 'main', 'exec', { cmd, exitCode, durationMs, stdout: stdout.substring(0, 300) });

  return { stdout, exitCode, durationMs };
}
