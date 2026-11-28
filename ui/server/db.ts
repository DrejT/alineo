import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ALINEO_UI_DATA_DIR lets a second instance (for example one shared through a tunnel) keep its own database.
const DATA_DIR = process.env.ALINEO_UI_DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "control-plane.db");
export const db = new Database(DB_PATH, { create: true });

// Production SQLite pragmas matching alineod & @alineo-labs/sqlite
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

// Initialize Schema with User-Wise Multitenancy
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'running' | 'paused' | 'terminated'
  parent_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  uptime_start INTEGER NOT NULL,      -- epoch ms
  egress_policy TEXT NOT NULL DEFAULT 'allowlist-enforced',
  cpu_limit_milli INTEGER NOT NULL DEFAULT 500,
  mem_limit_mi INTEGER NOT NULL DEFAULT 512,
  cpu_current_milli INTEGER NOT NULL DEFAULT 0,
  mem_current_mi INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL,
  checkpoint_id TEXT,
  checkpoint_ts INTEGER,
  mcp_tools TEXT NOT NULL DEFAULT '[]', -- JSON array of string tool names
  summary TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sandbox_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'exec_start' | 'exec_event' | 'exec_complete' | 'steer'
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sandbox_execs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  cmd TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                -- epoch ms
  type TEXT NOT NULL,                 -- 'exec_start' | 'exec_event' | 'checkpoint' | 'exec_complete'
  sandbox_id TEXT,
  tool TEXT NOT NULL,
  detail TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  short_label TEXT NOT NULL,
  payload TEXT,                       -- JSON string
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type);

CREATE TABLE IF NOT EXISTS working_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'local', -- 'local' | 'subtree' | 'swarm'
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, sandbox_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS episodic_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  parent_episode_id INTEGER,
  episode_type TEXT NOT NULL,         -- 'task_init' | 'analysis' | 'decision' | 'reflection' | 'result'
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  outcome TEXT,
  ts INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS semantic_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'swarm',
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  tags TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  ts INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS egress_gates (
  gate_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  target_host TEXT NOT NULL,
  protocol TEXT NOT NULL,             -- 'HTTPS' | 'TCP' | 'DNS'
  reason TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'pending' | 'allowed' | 'denied'
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision_by TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'active' | 'queued' | 'completed' | 'failed'
  assigned_slot INTEGER,
  queued_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vault_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  injection_type TEXT NOT NULL DEFAULT 'header',
  header_name TEXT,
  placeholder TEXT,
  target_surfaces TEXT NOT NULL DEFAULT '["header"]',
  secret_masked TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

try {
  db.run(`ALTER TABLE sandboxes ADD COLUMN model_provider TEXT DEFAULT 'claude-3-5-sonnet'`);
} catch {}
try {
  db.run(`ALTER TABLE sandboxes ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0`);
} catch {}
// Google sign-in: the account's stable Google id. NULL for accounts that only use a password.
try { db.run(`ALTER TABLE users ADD COLUMN google_sub TEXT`); } catch {}
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`);
// Swarm runs: a goal, the master agent that pursues it, and every sandbox that agent spawns.
for (const col of ["run_id TEXT", "task TEXT NOT NULL DEFAULT ''", "state TEXT NOT NULL DEFAULT 'idle'", "result TEXT NOT NULL DEFAULT ''"]) {
  try { db.run(`ALTER TABLE sandboxes ADD COLUMN ${col}`); } catch {}
}
db.run(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'starting' | 'running' | 'done' | 'failed' | 'stopped'
  model TEXT NOT NULL,
  max_agents INTEGER NOT NULL,
  master_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS swarm_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- 'user' | 'agent' | 'tool' | 'note' | 'error' | 'steer'
  ref TEXT,                           -- tool call id
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_sb ON agent_events (sandbox_id, id);
-- Diagnostics for debugging a run after the fact: why a turn ended, retries, waits, cancels. Server side only.
CREATE TABLE IF NOT EXISTS diag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT,
  sandbox_id TEXT,
  run_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_sb ON diag (sandbox_id, id);
CREATE INDEX IF NOT EXISTS idx_diag_run ON diag (run_id, id);
`);

// Diagnostics older than a week are not worth keeping.
db.run(`DELETE FROM diag WHERE ts < ?`, [Date.now() - 7 * 24 * 3600 * 1000]);

// Auto-seed default user if not exists
const defaultUser = db.query(`SELECT id FROM users WHERE username = 'test'`).get() as any;
// The seeded `test` user has a known password and a fixed session token. Never create it on an exposed instance.
if (!defaultUser && process.env.ALINEO_UI_NO_TEST_USER !== '1') {
  initDefaultUsersAndData();
}

export function initDefaultUsersAndData() {
  const now = Date.now();

  // Create default test user with credentials requested by the user:
  // "Test@123 test 122334 passwrod"
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('usr_test', 'test', 'test@alineo.ai', 'Test@123', 'Lead Operator', now);

  // Seed default session token for quick dev testing
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('tok_test_default_session', 'usr_test', now, now + 365 * 24 * 60 * 60 * 1000);

  // Seed PR #418 swarm for user 'usr_test'
  seedUserWorkspace('usr_test');
}

export function seedUserWorkspace(userId: string) {
  // The seed is a fictional PR #418 swarm: fake sandboxes, logs, execs and gates with no containers
  // behind them. Off by default now that sandboxes are real. Set ALINEO_UI_DEMO_SEED=1 to bring it back.
  if (process.env.ALINEO_UI_DEMO_SEED !== '1') return;
  const now = Date.now();
  const tMinus15m = now - 14 * 60 * 1000;
  const tMinus11m = now - 11 * 60 * 1000;

  // Generate deterministic/unique IDs per user to ensure complete multitenancy without PRIMARY KEY collisions
  const isDefault = userId === 'usr_test';
  const suffix = isDefault ? '' : '_' + userId.replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
  const rootId = isDefault ? 'sbx_8F4K2M' : `sbx_8F4${suffix}`;
  const secChildId = isDefault ? 'sbx_2Q9RTA' : `sbx_2Q9${suffix}`;
  const perfChildId = isDefault ? 'sbx_9M1L4X' : `sbx_9M1${suffix}`;
  const gate91 = isDefault ? 'gate_91' : `gate_91${suffix}`;
  const gate88 = isDefault ? 'gate_88' : `gate_88${suffix}`;
  const gate85 = isDefault ? 'gate_85' : `gate_85${suffix}`;

  // Insert Sandboxes
  const insertSb = db.prepare(`
    INSERT INTO sandboxes (
      id, user_id, role, status, parent_id, depth, uptime_start, egress_policy,
      cpu_limit_milli, mem_limit_mi, cpu_current_milli, mem_current_mi,
      pid, checkpoint_id, checkpoint_ts, mcp_tools, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSb.run(
    rootId,
    userId,
    'code-reviewer-root',
    'running',
    null,
    0,
    tMinus15m,
    'allowlist-enforced',
    500,
    512,
    310,
    296,
    4182,
    'cp_0142',
    now - 120_000,
    JSON.stringify(['GitHub', 'Slack']),
    'Orchestrating PR #418 review across forked security and performance sub-agents.'
  );

  insertSb.run(
    secChildId,
    userId,
    'reviewer-security',
    'paused',
    rootId,
    1,
    tMinus11m,
    'approval-gated',
    500,
    256,
    0,
    112,
    4209,
    'cp_0141',
    now - 300_000,
    JSON.stringify(['GitHub']),
    `Forked child inspecting JWT verification middleware; paused at cp_0141 awaiting OSV advisory egress approval (${gate91}).`
  );

  insertSb.run(
    perfChildId,
    userId,
    'reviewer-perf',
    'running',
    rootId,
    1,
    tMinus11m + 3000,
    'allowlist-enforced',
    500,
    256,
    370,
    174,
    4251,
    'cp_0142',
    now - 120_000,
    JSON.stringify(['Postgres']),
    'Running isolated EXPLAIN ANALYZE benchmarks against read-only Postgres replica.'
  );

  // Insert Logs
  const insertLog = db.prepare(`INSERT INTO sandbox_logs (user_id, sandbox_id, type, text, ts) VALUES (?, ?, ?, ?, ?)`);
  insertLog.run(userId, rootId, 'exec_start', `[17:10:02.114] exec_start: git diff origin/main...HEAD --stat`, tMinus15m + 2000);
  insertLog.run(userId, rootId, 'exec_event', `[17:10:06.402] fork_spawn: created child sandboxes ${secChildId} & ${perfChildId}`, tMinus15m + 6000);
  insertLog.run(userId, rootId, 'exec_complete', `[17:10:25.890] checkpoint_saved: snapshot cp_0142 persisted (148 KB CoW)`, tMinus15m + 25000);

  insertLog.run(userId, secChildId, 'exec_start', `[17:10:06.418] fork_init: cloned CoW rootfs from ${rootId}@cp_0141`, tMinus11m + 1000);
  insertLog.run(userId, secChildId, 'exec_event', `[17:10:19.005] exec_event: audited 14 auth routes for token leakage`, tMinus11m + 13000);
  insertLog.run(userId, secChildId, 'exec_complete', `[17:10:25.110] sandbox_paused: frozen at cp_0141 pending ${gate91} (api.osv.dev)`, tMinus11m + 20000);

  insertLog.run(userId, perfChildId, 'exec_start', `[17:10:07.220] exec_start: bun run bench/query_latency.ts`, tMinus11m + 2000);
  insertLog.run(userId, perfChildId, 'exec_event', `[17:10:18.940] exec_event: p99 query latency reduced from 84.2ms to 19.4ms`, tMinus11m + 14000);

  // Insert Execs
  const insertExec = db.prepare(`INSERT INTO sandbox_execs (user_id, sandbox_id, cmd, exit_code, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?)`);
  insertExec.run(userId, rootId, 'git diff origin/main...HEAD --stat', 0, 142, tMinus15m + 2000);
  insertExec.run(userId, rootId, 'alineo fork --role reviewer-security', 0, 88, tMinus15m + 6000);
  insertExec.run(userId, rootId, 'alineo checkpoint --tag cp_0142', 0, 38, tMinus15m + 25000);

  insertExec.run(userId, secChildId, 'rg "jwt.verify" src/middleware/', 0, 64, tMinus11m + 8000);
  insertExec.run(userId, secChildId, 'curl -s https://api.osv.dev/v1/querybatch', 2, 91, tMinus11m + 20000);

  insertExec.run(userId, perfChildId, 'bun run bench/query_latency.ts --iters 1200', 0, 812, tMinus11m + 12000);
  insertExec.run(userId, perfChildId, 'psql -c "EXPLAIN (ANALYZE, BUFFERS) SELECT ..."', 0, 44, tMinus11m + 15000);

  // Insert Ledger Events
  const insertLedger = db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertLedger.run(
    userId,
    tMinus15m + 2000,
    'exec_start',
    rootId,
    'SHELL',
    `Initialized root sandbox ${rootId} and fetched PR #418 diff.`,
    'main',
    'git diff',
    JSON.stringify({ cmd: 'git diff origin/main...HEAD', env: { GITHUB_TOKEN: '[REDACTED_EXEC_TIME]' } })
  );

  insertLedger.run(
    userId,
    tMinus15m + 6000,
    'checkpoint',
    rootId,
    'CHECKPOINT',
    `Saved snapshot cp_0141 and forked child sandboxes ${secChildId} & ${perfChildId}.`,
    'main',
    'fork split',
    JSON.stringify({ checkpoint: 'cp_0141', children: [secChildId, perfChildId], cowBytes: 148290 })
  );

  insertLedger.run(
    userId,
    tMinus11m + 13000,
    'exec_event',
    secChildId,
    'GITHUB_API',
    'Security fork audited 14 auth endpoints with scoped GITHUB_TOKEN.',
    'fork',
    'sec scan',
    JSON.stringify({ endpoint: 'api.github.com/repos/org/core/pulls/418', auth: '[REDACTED_EXEC_TIME]' })
  );

  insertLedger.run(
    userId,
    tMinus15m + 25000,
    'checkpoint',
    rootId,
    'CHECKPOINT',
    'Committed state checkpoint cp_0142 across root and performance worker.',
    'main',
    'snapshot',
    JSON.stringify({ checkpoint: 'cp_0142', adapter: 'SQLiteAdapter', secretsExposed: 0 })
  );

  insertLedger.run(
    userId,
    tMinus11m + 14000,
    'exec_event',
    perfChildId,
    'POSTGRES',
    'Performance fork verified p99 query latency within 20ms threshold.',
    'fork',
    'bench p99',
    JSON.stringify({ query: 'SELECT * FROM ledger WHERE run_id = $1', p99Ms: 19.4 })
  );

  insertLedger.run(
    userId,
    now - 60_000,
    'exec_complete',
    rootId,
    'SUPERVISOR',
    `Review consensus ready; holding for ${gate91} operator approval before merge comment.`,
    'main',
    'consensus',
    JSON.stringify({ verdict: 'PENDING_APPROVAL', issuesFound: 0, pendingEgress: 1 })
  );

  // Insert Working Memory
  const insertWorking = db.prepare(`
    INSERT INTO working_memory (user_id, sandbox_id, key, value, scope, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertWorking.run(userId, rootId, 'target_pr', '418', 'swarm', now - 14 * 60 * 1000);
  insertWorking.run(userId, rootId, 'review_status', 'in_progress', 'swarm', now - 2 * 60 * 1000);
  insertWorking.run(userId, secChildId, 'auth_routes_audited', '14', 'local', now - 10 * 60 * 1000);
  insertWorking.run(userId, secChildId, 'pending_gate', gate91, 'local', now - 5 * 60 * 1000);
  insertWorking.run(userId, perfChildId, 'p99_query_latency_ms', '19.4', 'local', now - 8 * 60 * 1000);

  // Insert Episodic Memory
  const insertEpisode = db.prepare(`
    INSERT INTO episodic_memory (user_id, sandbox_id, parent_episode_id, episode_type, title, detail, outcome, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const epRoot = insertEpisode.run(userId, rootId, null, 'task_init', 'Review PR #418 Inception', 'Assigned review for PR #418 touching JWT authentication & DB query paths.', 'Split into 2 parallel domain workers', tMinus15m);
  const epRootId = Number(epRoot.lastInsertRowid);
  insertEpisode.run(userId, secChildId, epRootId, 'analysis', 'JWT Middleware Audit', 'Discovered potential advisory check needed against OSV vulnerability database.', 'Requested outbound egress approval', tMinus11m + 10000);
  insertEpisode.run(userId, perfChildId, epRootId, 'decision', 'Postgres Benchmark Isolation', 'Executed benchmark suite with read-only connection pool to avoid write locks.', 'Benchmark verified 19.4ms p99', tMinus11m + 12000);

  // Insert Semantic Facts
  const insertFact = db.prepare(`
    INSERT INTO semantic_facts (user_id, scope, subject, predicate, object, confidence, tags, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertFact.run(userId, 'swarm', 'jwt.auth.middleware', 'requires_verification_algorithm', 'RS256', 0.99, JSON.stringify(['security', 'auth', 'jwt']), tMinus15m);
  insertFact.run(userId, 'swarm', 'api.osv.dev', 'is_vulnerability_database', 'trusted_external_source', 0.95, JSON.stringify(['security', 'cve', 'osv']), tMinus15m);
  insertFact.run(userId, 'swarm', 'postgres.replica', 'maximum_latency_threshold_ms', '25.0', 0.98, JSON.stringify(['perf', 'db', 'latency']), tMinus15m);
  insertFact.run(userId, 'swarm', 'code_review_policy', 'rejects_unredacted_secrets', 'true', 1.0, JSON.stringify(['policy', 'compliance']), tMinus15m);

  // Insert Egress Gates
  const insertGate = db.prepare(`
    INSERT INTO egress_gates (gate_id, user_id, sandbox_id, target_host, protocol, reason, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertGate.run(gate91, userId, secChildId, 'api.osv.dev:443', 'HTTPS', 'Query open source vulnerability batch database for CVE checks on JWT deps', 'pending', now - 300_000);
  insertGate.run(gate88, userId, rootId, 'api.github.com:443', 'HTTPS', 'Fetch pull request diff and review comments', 'allowed', tMinus15m + 1000);
  insertGate.run(gate85, userId, perfChildId, 'internal.metrics.corp:8443', 'TCP', 'Push benchmark metrics to telemetry collector', 'denied', tMinus11m + 5000);

  // Insert Workflow Concurrency Slots
  const insertWf = db.prepare(`
    INSERT INTO workflow_queue (user_id, name, step, status, assigned_slot, queued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertWf.run(userId, 'PR_Diff_Analyzer', 'Step 1/1 (Done)', 'completed', 1, tMinus15m);
  insertWf.run(userId, 'OSV_Security_Scan', 'Step 2/3 (Held)', 'active', 1, tMinus11m);
  insertWf.run(userId, 'Latency_Benchmark', 'Step 3/3 (Bench)', 'active', 2, tMinus11m);
  insertWf.run(userId, 'Consensus_Synthesis', 'Step 1/2 (Queued)', 'queued', null, now - 60_000);
}
