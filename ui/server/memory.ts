import { db } from "./db";

export interface WorkingMemoryItem {
  id: number;
  userId: string;
  sandboxId: string;
  key: string;
  value: string;
  scope: string;
  updatedAt: number;
}

export interface EpisodicMemoryItem {
  id: number;
  userId: string;
  sandboxId: string;
  parentEpisodeId: number | null;
  episodeType: string;
  title: string;
  detail: string;
  outcome: string | null;
  ts: number;
}

export interface SemanticFactItem {
  id: number;
  userId: string;
  scope: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  tags: string[];
  ts: number;
  score?: number;
}

export function listWorkingMemory(userId: string, sandboxId?: string): WorkingMemoryItem[] {
  const query = sandboxId
    ? db.query(`SELECT * FROM working_memory WHERE user_id = ? AND sandbox_id = ? ORDER BY updated_at DESC`)
    : db.query(`SELECT * FROM working_memory WHERE user_id = ? ORDER BY updated_at DESC`);
  const rows = (sandboxId ? query.all(userId, sandboxId) : query.all(userId)) as any[];

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    sandboxId: r.sandbox_id,
    key: r.key,
    value: r.value,
    scope: r.scope,
    updatedAt: r.updated_at,
  }));
}

export function setWorkingMemory(userId: string, sandboxId: string, key: string, value: string, scope = 'local'): WorkingMemoryItem {
  const now = Date.now();
  db.prepare(`
    INSERT INTO working_memory (user_id, sandbox_id, key, value, scope, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, sandbox_id, key) DO UPDATE SET value = excluded.value, scope = excluded.scope, updated_at = excluded.updated_at
  `).run(userId, sandboxId, key, value, scope, now);

  const row = db.query(`SELECT * FROM working_memory WHERE user_id = ? AND sandbox_id = ? AND key = ?`).get(userId, sandboxId, key) as any;
  return {
    id: row.id,
    userId: row.user_id,
    sandboxId: row.sandbox_id,
    key: row.key,
    value: row.value,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

export function deleteWorkingMemory(userId: string, sandboxId: string, key: string): boolean {
  db.prepare(`DELETE FROM working_memory WHERE user_id = ? AND sandbox_id = ? AND key = ?`).run(userId, sandboxId, key);
  return true;
}

export function listEpisodicMemory(userId: string, sandboxId?: string): EpisodicMemoryItem[] {
  const query = sandboxId
    ? db.query(`SELECT * FROM episodic_memory WHERE user_id = ? AND sandbox_id = ? ORDER BY ts ASC`)
    : db.query(`SELECT * FROM episodic_memory WHERE user_id = ? ORDER BY ts ASC`);
  const rows = (sandboxId ? query.all(userId, sandboxId) : query.all(userId)) as any[];

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    sandboxId: r.sandbox_id,
    parentEpisodeId: r.parent_episode_id,
    episodeType: r.episode_type,
    title: r.title,
    detail: r.detail,
    outcome: r.outcome,
    ts: r.ts,
  }));
}

export function addEpisodicMemory(userId: string, params: {
  sandboxId: string;
  parentEpisodeId?: number | null;
  episodeType: string;
  title: string;
  detail: string;
  outcome?: string;
}): EpisodicMemoryItem {
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO episodic_memory (user_id, sandbox_id, parent_episode_id, episode_type, title, detail, outcome, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    params.sandboxId,
    params.parentEpisodeId || null,
    params.episodeType,
    params.title,
    params.detail,
    params.outcome || null,
    now
  );

  return {
    id: Number(res.lastInsertRowid),
    userId,
    sandboxId: params.sandboxId,
    parentEpisodeId: params.parentEpisodeId || null,
    episodeType: params.episodeType,
    title: params.title,
    detail: params.detail,
    outcome: params.outcome || null,
    ts: now,
  };
}

export function recallSemanticFacts(userId: string, queryStr?: string, topK = 5, minConfidence = 0.5): SemanticFactItem[] {
  const rows = db.query(`SELECT * FROM semantic_facts WHERE user_id = ? AND confidence >= ? ORDER BY ts DESC`).all(userId, minConfidence) as any[];

  const facts: SemanticFactItem[] = rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    scope: r.scope,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    tags: JSON.parse(r.tags || '[]'),
    ts: r.ts,
  }));

  if (!queryStr || queryStr.trim() === '') {
    return facts.slice(0, topK);
  }

  const terms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);

  const scored = facts.map(fact => {
    let score = 0;
    const fullText = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.tags.join(' ')}`.toLowerCase();

    for (const term of terms) {
      if (fact.subject.toLowerCase().includes(term)) score += 3.0;
      if (fact.predicate.toLowerCase().includes(term)) score += 2.0;
      if (fact.object.toLowerCase().includes(term)) score += 2.5;
      if (fact.tags.some(t => t.toLowerCase().includes(term))) score += 1.5;
      if (fullText.includes(term)) score += 1.0;
    }

    score *= fact.confidence;
    return { ...fact, score: Number(score.toFixed(3)) };
  });

  return scored
    .filter(f => (f.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);
}

export function addSemanticFact(userId: string, params: {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  tags?: string[];
  scope?: string;
}): SemanticFactItem {
  const now = Date.now();
  const conf = params.confidence ?? 1.0;
  const tags = params.tags || [];
  const scope = params.scope || 'swarm';

  const res = db.prepare(`
    INSERT INTO semantic_facts (user_id, scope, subject, predicate, object, confidence, tags, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, scope, params.subject, params.predicate, params.object, conf, JSON.stringify(tags), now);

  return {
    id: Number(res.lastInsertRowid),
    userId,
    scope,
    subject: params.subject,
    predicate: params.predicate,
    object: params.object,
    confidence: conf,
    tags,
    ts: now,
  };
}

export function compactMemory(userId: string): { prunedEpisodes: number; prunedFacts: number; freedBytes: number } {
  const oldThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const prunedFactsRes = db.prepare(`DELETE FROM semantic_facts WHERE user_id = ? AND (confidence < 0.4 OR ts < ?)`).run(userId, oldThreshold);
  const prunedEpRes = db.prepare(`DELETE FROM episodic_memory WHERE user_id = ? AND (outcome IS NULL AND ts < ?)`).run(userId, oldThreshold);

  db.exec("VACUUM;");

  return {
    prunedEpisodes: Number(prunedEpRes.changes),
    prunedFacts: Number(prunedFactsRes.changes),
    freedBytes: (Number(prunedEpRes.changes) + Number(prunedFactsRes.changes)) * 128 + 4096,
  };
}
