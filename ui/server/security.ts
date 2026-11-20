import { db } from "./db";
import { getSandbox, resumeSandbox } from "./sandboxes";

export interface EgressGateItem {
  gateId: string;
  userId: string;
  sandboxId: string;
  targetHost: string;
  protocol: string;
  reason: string;
  status: 'pending' | 'allowed' | 'denied';
  requestedAt: number;
  decidedAt: number | null;
  decisionBy: string | null;
}

export function listEgressGates(userId: string): EgressGateItem[] {
  const rows = db.query(`SELECT * FROM egress_gates WHERE user_id = ? ORDER BY requested_at DESC`).all(userId) as any[];
  return rows.map(r => ({
    gateId: r.gate_id,
    userId: r.user_id,
    sandboxId: r.sandbox_id,
    targetHost: r.target_host,
    protocol: r.protocol,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decisionBy: r.decision_by,
  }));
}

export function decideEgressGate(userId: string, gateId: string, decision: 'allowed' | 'denied', decidedBy = 'operator'): EgressGateItem | null {
  const now = Date.now();
  const gate = db.query(`SELECT * FROM egress_gates WHERE user_id = ? AND gate_id = ?`).get(userId, gateId) as any;
  if (!gate) return null;

  db.prepare(`
    UPDATE egress_gates
    SET status = ?, decided_at = ?, decision_by = ?
    WHERE user_id = ? AND gate_id = ?
  `).run(decision, now, decidedBy, userId, gateId);

  // If approved and sandbox is paused, automatically resume it!
  if (decision === 'allowed') {
    const sb = getSandbox(userId, gate.sandbox_id);
    if (sb && sb.status === 'paused') {
      resumeSandbox(userId, gate.sandbox_id);
    }
  }

  // Record in ledger
  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    now,
    'exec_event',
    gate.sandbox_id,
    'EGRESS_GATE',
    `Egress request ${gateId} to ${gate.target_host} was ${decision.toUpperCase()} by ${decidedBy}`,
    'main',
    `gate ${decision}`,
    JSON.stringify({ gateId, targetHost: gate.target_host, decision, decidedBy })
  );

  const updated = db.query(`SELECT * FROM egress_gates WHERE user_id = ? AND gate_id = ?`).get(userId, gateId) as any;
  return {
    gateId: updated.gate_id,
    userId: updated.user_id,
    sandboxId: updated.sandbox_id,
    targetHost: updated.target_host,
    protocol: updated.protocol,
    reason: updated.reason,
    status: updated.status,
    requestedAt: updated.requested_at,
    decidedAt: updated.decided_at,
    decisionBy: updated.decision_by,
  };
}

export function createEgressGate(userId: string, params: {
  sandboxId: string;
  targetHost: string;
  protocol?: string;
  reason: string;
}): EgressGateItem {
  const now = Date.now();
  const gateId = 'gate_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
  const protocol = params.protocol || 'HTTPS';

  db.prepare(`
    INSERT INTO egress_gates (gate_id, user_id, sandbox_id, target_host, protocol, reason, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gateId, userId, params.sandboxId, params.targetHost, protocol, params.reason, 'pending', now);

  return {
    gateId,
    userId,
    sandboxId: params.sandboxId,
    targetHost: params.targetHost,
    protocol,
    reason: params.reason,
    status: 'pending',
    requestedAt: now,
    decidedAt: null,
    decisionBy: null,
  };
}
