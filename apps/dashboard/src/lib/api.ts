/**
 * Typed client for the dashboard server's HTTP API (`server/`). That server owns sandboxes,
 * workflows, swarms and settings, and forwards runs and agents to alineod. Dev: Vite proxies
 * `/api/*` to it (astro.config.mjs), so requests are same-origin. A production deploy sets
 * `PUBLIC_DASHBOARD_URL` to the server's origin.
 *
 * Every request carries the bearer token. On a 401 the client asks for the token once, keeps it
 * for the browser session, and retries. A WebSocket cannot send headers, so it opens with a
 * single-use ticket from `POST /auth/ticket` (see `openSocket`).
 */
export const BASE = import.meta.env.PUBLIC_DASHBOARD_URL ?? "/api";

const TOKEN_KEY = "dashboard-token";

function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let authToken: string | null = storedToken();
function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — the token then lasts for this page load only
  }
}

/** Headers every call to the server needs. SSE uses this too. */
export function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function askForToken(): boolean {
  const token = typeof window === "undefined" ? null : window.prompt("Dashboard token");
  if (!token) return false;
  setAuthToken(token.trim());
  return true;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried && askForToken()) return request<T>(method, path, body, true);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `${method} ${path} → ${res.status}`);
  return data as T;
}

// ── sandboxes ────────────────────────────────────────────────────────────────

export interface SandboxDetails {
  name: string;
  sandboxId: string;
  status: "running" | "completed";
  startedAt: number;
  completedAt?: number;
  execCount: number;
  runId: string;
  parentSandboxId?: string;
}

export interface CreateSandboxInput {
  name?: string;
  image?: string;
  resources: { cpu: string; memory: string; gpu?: string };
  env?: Record<string, string>;
  timeout?: number;
  networkPolicy?: {
    defaultAction?: "allow" | "deny";
    egress: { action: "allow" | "deny"; target: string }[];
  };
  credentialProxy?: boolean;
}

export const sandboxes = {
  list: (status?: "running" | "completed") =>
    request<{ sandboxes: SandboxDetails[] }>(
      "GET",
      `/sandboxes${status ? `?status=${status}` : ""}`,
    ),
  get: (id: string) => request<SandboxDetails>("GET", `/sandboxes/${id}`),
  create: (body: CreateSandboxInput) => request<SandboxDetails>("POST", "/sandboxes", body),
  close: (id: string) => request<void>("DELETE", `/sandboxes/${id}`),
  checkpoint: (id: string, name?: string) =>
    request<{ snapshotId: string }>("POST", `/sandboxes/${id}/checkpoint`, { name }),
  listCheckpoints: (id: string) =>
    request<{ checkpoints: { snapshotId: string; tag?: string; createdAt: number }[] }>(
      "GET",
      `/sandboxes/${id}/checkpoints`,
    ),
  fork: (id: string, tag?: string) =>
    request<{ sandboxId: string; name: string }>("POST", `/sandboxes/${id}/fork`, { tag }),
  setCredential: (
    id: string,
    name: string,
    value: string,
    binding: { host: string; pathPrefix?: string; injection: unknown },
  ) => request<void>("POST", `/sandboxes/${id}/credentials`, { name, value, binding }),
  listCredentials: (id: string) =>
    request<{ bindings: { name: string; binding: unknown }[] }>(
      "GET",
      `/sandboxes/${id}/credentials`,
    ),
  removeCredential: (id: string, name: string) =>
    request<void>("DELETE", `/sandboxes/${id}/credentials/${name}`),
  events: (id: string) =>
    request<{
      events: {
        ts: number;
        name: string;
        sandboxId: string;
        stepIndex: number;
        event: string;
        payload?: unknown;
        error?: string;
      }[];
    }>("GET", `/sandboxes/${id}/events`),
  getEgress: (id: string) => request<unknown>("GET", `/sandboxes/${id}/egress`),
  patchEgress: (id: string, rules: { action: "allow" | "deny"; target: string }[]) =>
    request<void>("PATCH", `/sandboxes/${id}/egress`, { rules }),
  deleteEgress: (id: string, targets: string[]) =>
    request<void>("DELETE", `/sandboxes/${id}/egress`, { targets }),
};

/** Opens a WebSocket on the dashboard server. Gets a single-use ticket first, because a browser
 *  WebSocket cannot send an `Authorization` header. */
export async function openSocket(path: string): Promise<WebSocket> {
  const { ticket } = await request<{ ticket: string }>("POST", "/auth/ticket");
  const base = BASE.startsWith("http") ? BASE : `${location.protocol}//${location.host}${BASE}`;
  return new WebSocket(
    `${base.replace(/^http/, "ws")}${path}?ticket=${encodeURIComponent(ticket)}`,
  );
}

// ── runs / agents (sessions + swarms) ───────────────────────────────────────

export interface AgentView {
  agentId: string;
  runId: string;
  parentAgentId: string | null;
  depth: number;
  spawnIndex: number;
  state: string;
  specName: string;
  sandboxId: string | null;
  createdAt: number;
  endedAt: number | null;
  outcome: string | null;
  pausedBy: string | null;
}

export const runs = {
  list: () =>
    request<{ runs: { runId: string; rootAgentId: string | null; asOf: number }[] }>(
      "GET",
      "/runs",
    ),
  get: (runId: string) =>
    request<{ runId: string; rootAgentId: string | null; agents: AgentView[]; asOf: number }>(
      "GET",
      `/runs/${runId}`,
    ),
  create: (
    spec: Record<string, unknown>,
    prompt?: string,
    budget?: { spawnDepth?: number; maxAgents?: number },
  ) =>
    request<{ runId: string; rootAgentId: string; state: string }>("POST", "/runs", {
      spec,
      prompt,
      budget,
    }),
  delete: (runId: string) => request<void>("DELETE", `/runs/${runId}`),
};

export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { name: string; arguments: unknown }[];
  toolName?: string;
  isError?: boolean;
}

interface TranscriptTurn {
  seq: number;
  ts: number;
  messages: TranscriptMessage[];
}

export const agents = {
  get: (agentId: string) =>
    request<AgentView & { sessionStats?: unknown }>("GET", `/agents/${agentId}`),
  transcript: (agentId: string, full = false) =>
    request<{ agentId: string; turns: TranscriptTurn[] }>(
      "GET",
      `/agents/${agentId}/transcript${full ? "?full=1" : ""}`,
    ),
  prompt: (agentId: string, text: string) =>
    request<void>("POST", `/agents/${agentId}/prompt`, { text }),
  steer: (agentId: string, message: string) =>
    request<void>("POST", `/agents/${agentId}/steer`, { message }),
  pause: (agentId: string) => request<void>("POST", `/agents/${agentId}/pause`, {}),
  resume: (agentId: string) => request<void>("POST", `/agents/${agentId}/resume`, {}),
  stop: (agentId: string, mode: "abort" | "drain" = "abort") =>
    request<void>("POST", `/agents/${agentId}/stop`, { mode }),
  result: (agentId: string) => request<unknown>("GET", `/agents/${agentId}/result`),
  resolvePermission: (agentId: string, requestId: string, decision: unknown) =>
    request<void>("PATCH", `/agents/${agentId}/permissions/${requestId}`, { decision }),
};

// ── swarms (NL creation) ─────────────────────────────────────────────────────

export interface PlanNode {
  id: string;
  role: string;
  task: string;
  parentId: string | null;
  waitFor?: string[];
}

export interface SwarmPlan {
  nodes: PlanNode[];
  spawnDepth: number;
  maxAgents: number;
  ambiguous: boolean;
  violatesLimits: string[];
}

export const swarms = {
  plan: (prompt: string) => request<SwarmPlan>("POST", "/swarms/plan", { prompt }),
  create: (plan: Pick<SwarmPlan, "nodes" | "spawnDepth" | "maxAgents">) =>
    request<{ runId: string; agentIds: Record<string, string> }>("POST", "/swarms", plan),
};

// ── workflows ─────────────────────────────────────────────────────────────────

export interface WorkflowRun {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  sandbox_id: string | null;
  created_at: number;
  ended_at: number | null;
  error: string | null;
}

export interface WorkflowStep {
  run_id: string;
  step_index: number;
  name: string;
  run: string;
  status: "pending" | "running" | "done" | "failed";
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
}

export const workflows = {
  list: () => request<{ runs: WorkflowRun[] }>("GET", "/workflows"),
  get: (id: string) =>
    request<{ run: WorkflowRun; steps: WorkflowStep[] }>("GET", `/workflows/${id}`),
  create: (name: string, steps: { name: string; run: string }[]) =>
    request<{ id: string }>("POST", "/workflows", { name, steps }),
  retry: (id: string) => request<{ id: string }>("POST", `/workflows/${id}/retry`),
};

// ── settings ──────────────────────────────────────────────────────────────────

export const settings = {
  get: () => request<Record<string, unknown>>("GET", "/settings"),
};
