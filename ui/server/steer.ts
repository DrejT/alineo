import { db } from "./db";
import { getSandbox, listSandboxes } from "./sandboxes";

export function steerAgent(
  userId: string,
  sandboxId: string,
  directive: string,
  scope: 'node' | 'subtree' | 'fleet' = 'node'
): { affectedSandboxIds: string[]; directive: string; scope: string } {
  const sb = getSandbox(userId, sandboxId);
  if (!sb) throw new Error(`Sandbox ${sandboxId} not found`);

  const now = Date.now();
  const timeStr = new Date(now).toISOString().substring(11, 23);
  const affected: string[] = [sb.id];

  const allSandboxes = listSandboxes(userId);

  if (scope === 'subtree') {
    const findChildren = (parentId: string) => {
      const children = allSandboxes.filter(s => s.parentId === parentId);
      for (const child of children) {
        if (!affected.includes(child.id)) {
          affected.push(child.id);
          findChildren(child.id);
        }
      }
    };
    findChildren(sb.id);
  } else if (scope === 'fleet') {
    for (const s of allSandboxes) {
      if (!affected.includes(s.id)) affected.push(s.id);
    }
  }

  // Insert log entries
  const insertLog = db.prepare(`INSERT INTO sandbox_logs (user_id, sandbox_id, type, text, ts) VALUES (?, ?, ?, ?, ?)`);

  for (const id of affected) {
    const isRoot = id === sb.id;
    const msg = isRoot
      ? `[${timeStr}] POST /agents/${id}/steer (scope=${scope}) -> "${directive}"`
      : `[${timeStr}] inherited subtree steer from ${sb.id} -> "${directive}"`;
    insertLog.run(userId, id, 'steer', msg, now);
  }

  // Record ledger event
  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    now,
    'exec_event',
    sb.id,
    'AGENT_STEER',
    `Steered ${sb.id} (scope=${scope}, affected=${affected.length}): "${directive}"`,
    sb.parentId ? 'fork' : 'main',
    'steer',
    JSON.stringify({ target: sb.id, scope, directive, affected })
  );

  return {
    affectedSandboxIds: affected,
    directive,
    scope,
  };
}
