const TOKEN_KEY = 'aln_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function authHeaders() {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function request(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json().catch(() => ({}));
}

export const api = {
  // Auth
  login: (identity, password) => request('POST', '/api/auth/login', { usernameOrEmail: identity, identity, password }),
  signup: (username, email, password) => request('POST', '/api/auth/signup', { username, email, password }),
  getMe: () => request('GET', '/api/auth/me'),
  logout: () => request('POST', '/api/auth/logout'),

  // Status
  getStatus: () => request('GET', '/api/status'),

  // Sandboxes
  listSandboxes: () => request('GET', '/api/sandboxes'),
  spawnSandbox: (body) => request('POST', '/api/sandboxes', body),
  getSandbox: (id) => request('GET', `/api/sandboxes/${id}`),
  terminateSandbox: (id) => request('DELETE', `/api/sandboxes/${id}`),
  pauseSandbox: (id) => request('POST', `/api/sandboxes/${id}/pause`),
  resumeSandbox: (id) => request('POST', `/api/sandboxes/${id}/resume`),
  forkSandbox: (id, role) => request('POST', `/api/sandboxes/${id}/fork`, role ? { role } : {}),
  checkpointSandbox: (id, tag) => request('POST', `/api/sandboxes/${id}/checkpoint`, { tag }),
  execInSandbox: (id, command) => request('POST', `/api/sandboxes/${id}/exec`, { command }),
  steerAgent: (id, directive, scope) => request('POST', `/api/sandboxes/${id}/steer`, { directive, scope }),

  // Ledger
  listLedger: (type) => request('GET', `/api/ledger${type && type !== 'all' ? `?type=${type}` : ''}`),
  replayLedger: (seq) => request('POST', '/api/ledger/replay', { seq }),

  // Memory
  getWorkingMemory: (sandboxId) => request('GET', `/api/memory/working${sandboxId ? `?sandboxId=${sandboxId}` : ''}`),
  setWorkingMemory: (sandboxId, key, value, scope) => request('PUT', '/api/memory/working', { sandboxId, key, value, scope }),
  deleteWorkingMemory: (sandboxId, key) => request('DELETE', `/api/memory/working/${sandboxId}/${key}`),
  getEpisodicMemory: (sandboxId) => request('GET', `/api/memory/episodic${sandboxId ? `?sandboxId=${sandboxId}` : ''}`),
  addEpisodicMemory: (body) => request('POST', '/api/memory/episodic', body),
  getSemanticFacts: (query, topK) => {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (topK) params.set('topK', topK);
    const qs = params.toString();
    return request('GET', `/api/memory/semantic${qs ? `?${qs}` : ''}`);
  },
  searchSemanticFacts: (query) => {
    return request('GET', `/api/memory/semantic?query=${encodeURIComponent(query)}`);
  },
  compactMemory: () => request('POST', '/api/memory/compact'),

  // Security & Vault
  listEgressGates: () => request('GET', '/api/security/egress'),
  createEgressGate: (body) => request('POST', '/api/security/egress', body),
  decideEgressGate: (gateId, decision) => request('POST', `/api/security/egress/${gateId}/decide`, { decision }),
  listVaultCredentials: () => request('GET', '/api/security/vault'),
  addVaultCredential: (body) => request('POST', '/api/security/vault', body),
  deleteVaultCredential: (id) => request('DELETE', `/api/security/vault/${id}`),

  // Workflows
  getWorkflowState: () => request('GET', '/api/workflows'),
  enqueueWorkflowJob: (name, step) => request('POST', '/api/workflows/enqueue', { name, step }),
  flushWorkflowPipeline: () => request('POST', '/api/workflows/flush'),

  // Daemon
  setStorageAdapter: (adapter) => request('POST', '/api/daemon/adapter', { adapter }),
  toggleDaemonPower: () => request('POST', '/api/daemon/power'),

  // CLI Runner
  runCliCommand: (command) => request('POST', '/api/cli/run', { command }),

  // Demo
  runDemoUseCase: () => request('POST', '/api/demo/run-usecase'),
};
