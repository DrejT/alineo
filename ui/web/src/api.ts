export const TOKEN_KEY = "aln_token";

export interface User { id: string; username: string; email: string; displayName: string; createdAt: number }
export interface Sandbox {
  id: string; userId: string; role: string; status: "running" | "paused" | "terminated";
  parentId: string | null; depth: number; uptime: string; uptimeStart: number; egressPolicy: string;
  cpuLimitMilli: number; memLimitMi: number; cpuCurrentMilli: number; memCurrentMi: number; pid: number;
  checkpointId: string | null; checkpointAgo: string; checkpointTs: number | null;
  mcpTools: string[]; modelProvider: string; summary: string;
  recentExecs: { cmd: string; exit: number | string; dur: string; ts: string }[];
  logs: { type: string; text: string }[];
}
export interface Status {
  user: User;
  daemon: { online: boolean; port: number; adapter: string; bootTime: number; uptimeSeconds: number };
  fleet: { total: number; running: number; paused: number; pendingGates: number; activeWorkflowSlots: number; queuedJobs: number };
}
export interface LedgerEvent {
  seq: number; ts: number; type: string; sandbox_id: string; tool: string; detail: string;
  branch: string; short_label: string; payload: string;
}
export interface WorkingMemoryItem { id: number; sandboxId: string; key: string; value: string; scope: string; updatedAt: number }
export interface EpisodicMemoryItem { id: number; sandboxId: string; parentEpisodeId: number | null; episodeType: string; title: string; detail: string; outcome: string | null; ts: number }
export interface SemanticFact { id: number; scope: string; subject: string; predicate: string; object: string; confidence: number; tags: string[]; ts: number; score?: number }
export interface EgressGate { gateId: string; sandboxId: string; targetHost: string; protocol: string; reason: string; status: "pending" | "allowed" | "denied"; requestedAt: number; decidedAt: number | null; decisionBy: string | null }
export interface VaultCredential { id: string; name: string; host: string; injectionMethod: string; header_name?: string; maskedValue: string; targetSurfaces: string[]; created_at?: number }
export interface WorkflowJob { id: number; name: string; step: string; status: "active" | "queued" | "completed" | "failed"; assignedSlot: number | null; queuedAt: number }
export interface WorkflowSlot { slot: number; status: "active" | "queued" | "open"; jobName: string | null; stepText: string | null }
export interface WorkflowState { maxConcurrency: number; slots: WorkflowSlot[]; activeCount: number; queuedCount: number; openSlots: number; jobs: WorkflowJob[] }

export class AuthError extends Error {}

const token = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
export const setToken = (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* storage blocked */ } };
export const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };
export const hasToken = () => token() !== "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !path.startsWith("/api/auth/")) { clearToken(); throw new AuthError("Session expired"); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json().catch(() => ({})) as Promise<T>;
}

const q = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  login: (identity: string, password: string) => request<{ token: string; user: User }>("POST", "/api/auth/login", { usernameOrEmail: identity, identity, password }),
  signup: (username: string, email: string, password: string) => request<{ token: string; user: User }>("POST", "/api/auth/signup", { username, email, password }),
  logout: () => request("POST", "/api/auth/logout"),
  status: () => request<Status>("GET", "/api/status"),

  sandboxes: () => request<Sandbox[]>("GET", "/api/sandboxes"),
  spawn: (b: { role: string; parentId?: string | null; cpuLimitMilli: number; memLimitMi: number; modelProvider: string; mcpTools?: string[] }) => request<Sandbox>("POST", "/api/sandboxes", b),
  terminate: (id: string) => request("DELETE", `/api/sandboxes/${id}`),
  pause: (id: string) => request("POST", `/api/sandboxes/${id}/pause`),
  resume: (id: string) => request("POST", `/api/sandboxes/${id}/resume`),
  fork: (id: string, role?: string) => request<Sandbox>("POST", `/api/sandboxes/${id}/fork`, role ? { role } : {}),
  checkpoint: (id: string, tag?: string) => request<{ checkpointId: string }>("POST", `/api/sandboxes/${id}/checkpoint`, { tag }),
  exec: (id: string, command: string) => request<{ stdout: string; exitCode: number; durationMs: number }>("POST", `/api/sandboxes/${id}/exec`, { command }),
  steer: (id: string, directive: string, scope: string) => request<{ affectedSandboxIds: string[] }>("POST", `/api/sandboxes/${id}/steer`, { directive, scope }),

  ledger: (type?: string) => request<LedgerEvent[]>("GET", `/api/ledger${type && type !== "all" ? q({ type }) : ""}`),
  replay: (seq: number) => request<{ replayedEvents: LedgerEvent[] }>("POST", "/api/ledger/replay", { seq }),

  working: () => request<WorkingMemoryItem[]>("GET", "/api/memory/working"),
  setWorking: (sandboxId: string, key: string, value: string, scope: string) => request("PUT", "/api/memory/working", { sandboxId, key, value, scope }),
  delWorking: (sandboxId: string, key: string) => request("DELETE", `/api/memory/working/${sandboxId}/${encodeURIComponent(key)}`),
  episodic: () => request<EpisodicMemoryItem[]>("GET", "/api/memory/episodic"),
  semantic: (query?: string) => request<SemanticFact[]>("GET", `/api/memory/semantic${q({ query })}`),
  compact: () => request<Record<string, number>>("POST", "/api/memory/compact"),

  gates: () => request<EgressGate[]>("GET", "/api/security/egress"),
  decide: (gateId: string, decision: "allowed" | "denied") => request("POST", `/api/security/egress/${gateId}/decide`, { decision }),
  vault: () => request<VaultCredential[]>("GET", "/api/security/vault"),
  addVault: (b: { name: string; host: string; secret: string; injectionType?: string; headerName?: string }) => request("POST", "/api/security/vault", b),
  delVault: (id: string) => request("DELETE", `/api/security/vault/${id}`),

  workflows: () => request<WorkflowState>("GET", "/api/workflows"),
  enqueue: (name: string, step: string) => request("POST", "/api/workflows/enqueue", { name, step }),
  flush: () => request("POST", "/api/workflows/flush"),

  cli: (command: string) => request<{ command: string; exitCode: number; output: string; durationMs: number }>("POST", "/api/cli/run", { command }),
};
