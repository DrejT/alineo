import { db } from "./db";

export interface WorkflowJob {
  id: number;
  userId: string;
  name: string;
  step: string;
  status: 'active' | 'queued' | 'completed' | 'failed';
  assignedSlot: number | null;
  queuedAt: number;
  completedAt: number | null;
}

export interface WorkflowSlot {
  slot: number;
  status: 'active' | 'queued' | 'open';
  jobName: string | null;
  stepText: string | null;
}

const MAX_CONCURRENCY = 4;

export function getWorkflowState(userId: string): {
  maxConcurrency: number;
  slots: WorkflowSlot[];
  activeCount: number;
  queuedCount: number;
  openSlots: number;
  jobs: WorkflowJob[];
} {
  const jobs = db.query(`SELECT * FROM workflow_queue WHERE user_id = ? ORDER BY queued_at ASC`).all(userId) as any[];

  const activeJobs = jobs.filter(j => j.status === 'active');
  const queuedJobs = jobs.filter(j => j.status === 'queued');

  const slots: WorkflowSlot[] = [];
  for (let s = 1; s <= MAX_CONCURRENCY; s++) {
    const active = activeJobs.find(j => j.assigned_slot === s);
    if (active) {
      slots.push({
        slot: s,
        status: 'active',
        jobName: active.name,
        stepText: active.step,
      });
    } else if (queuedJobs.length > 0 && slots.filter(sl => sl.status === 'active').length === activeJobs.length) {
      const q = queuedJobs.shift();
      slots.push({
        slot: s,
        status: 'queued',
        jobName: q ? q.name : null,
        stepText: q ? q.step : null,
      });
    } else {
      slots.push({
        slot: s,
        status: 'open',
        jobName: null,
        stepText: null,
      });
    }
  }

  const activeCount = slots.filter(s => s.status === 'active').length;
  const queuedCount = jobs.filter(j => j.status === 'queued').length;
  const openSlots = MAX_CONCURRENCY - activeCount;

  return {
    maxConcurrency: MAX_CONCURRENCY,
    slots,
    activeCount,
    queuedCount,
    openSlots,
    jobs: jobs.map(j => ({
      id: j.id,
      userId: j.user_id,
      name: j.name,
      step: j.step,
      status: j.status,
      assignedSlot: j.assigned_slot,
      queuedAt: j.queued_at,
      completedAt: j.completed_at,
    })),
  };
}

export function enqueueWorkflowJob(userId: string, name?: string, step?: string): WorkflowJob {
  const now = Date.now();
  const jobName = name || `Job_${Math.floor(100 + Math.random() * 900)}`;
  const stepText = step || 'Step 1/2 (Queued)';

  const current = getWorkflowState(userId);
  const assignedSlot = current.openSlots > 0
    ? (current.slots.find(s => s.status === 'open')?.slot ?? null)
    : null;
  const status = assignedSlot ? 'active' : 'queued';

  const res = db.prepare(`
    INSERT INTO workflow_queue (user_id, name, step, status, assigned_slot, queued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, jobName, stepText, status, assignedSlot, now);

  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    now,
    'exec_event',
    null,
    'WORKFLOW',
    `Enqueued pipeline job "${jobName}" (${status}) in @alineo-labs/workflow`,
    'main',
    'wf enqueue',
    JSON.stringify({ jobName, stepText, status, assignedSlot })
  );

  return {
    id: Number(res.lastInsertRowid),
    userId,
    name: jobName,
    step: stepText,
    status,
    assignedSlot,
    queuedAt: now,
    completedAt: null,
  };
}

export function flushWorkflowPipeline(userId: string): { flushedCount: number } {
  const now = Date.now();
  const activeRes = db.prepare(`
    UPDATE workflow_queue
    SET status = 'completed', completed_at = ?
    WHERE user_id = ? AND status = 'active'
  `).run(now, userId);

  const queued = db.query(`SELECT id FROM workflow_queue WHERE user_id = ? AND status = 'queued' ORDER BY queued_at ASC LIMIT ?`).all(userId, MAX_CONCURRENCY) as any[];
  let slotIdx = 1;
  for (const q of queued) {
    db.prepare(`UPDATE workflow_queue SET status = 'active', assigned_slot = ? WHERE id = ?`).run(slotIdx++, q.id);
  }

  const flushedCount = Number(activeRes.changes);

  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    now,
    'exec_complete',
    null,
    'WORKFLOW',
    `Flushed pipeline: completed ${flushedCount} tasks and promoted next batch in @alineo-labs/workflow`,
    'main',
    'wf flush',
    JSON.stringify({ flushedCount, promotedCount: queued.length })
  );

  return { flushedCount };
}
