export interface SandboxSummary {
  id: string;
  name: string;
}

export interface AgentSummary {
  id: string;
  name: string;
}

export interface FileEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

import type { PiModel, PiSessionState, SessionStats } from "@alineo-labs/agent";
export type { PiModel, PiSessionState, SessionStats, ThinkingLevel } from "@alineo-labs/agent";

export interface ForkPoint {
  entryId: string;
  text: string;
}

/**
 * Base URL for the API/WS backend. Empty string means same-origin (local dev,
 * where the Bun backend serves both the API and the built frontend). Set to
 * e.g. "https://sandbox-api.drej.dev" for the Cloudflare Pages deployment,
 * where the frontend and backend are on different origins.
 */
const API_BASE = import.meta.env.PUBLIC_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listSandboxes: () => request<{ sandboxes: SandboxSummary[]; max: number }>("/api/sandboxes"),
  createSandbox: () => request<SandboxSummary>("/api/sandboxes", { method: "POST" }),
  deleteSandbox: (id: string) => request<void>(`/api/sandboxes/${id}`, { method: "DELETE" }),

  listDirectory: (id: string, path: string) =>
    request<{ entries: FileEntry[] }>(
      `/api/sandboxes/${id}/files?path=${encodeURIComponent(path)}`,
    ),
  readFile: (id: string, path: string) =>
    request<{ path: string; content: string }>(
      `/api/sandboxes/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (id: string, path: string, content: string) =>
    request<{ path: string }>(`/api/sandboxes/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body: content,
    }),

  getMetrics: (id: string) =>
    request<{ cpu: number; memory: number; timestamp: string }>(`/api/sandboxes/${id}/metrics`),
  listCheckpoints: (id: string) =>
    request<{ checkpoints: { snapshotId: string; tag?: string; createdAt: number }[] }>(
      `/api/sandboxes/${id}/checkpoints`,
    ),
  createCheckpoint: (id: string) =>
    request<{ snapshotId: string }>(`/api/sandboxes/${id}/checkpoint`, { method: "POST" }),
  getPreview: (id: string, port: number) =>
    request<{ url: string; headers: Record<string, string> }>(
      `/api/sandboxes/${id}/preview?port=${port}`,
    ),

  listAgents: () =>
    request<{ agents: AgentSummary[]; max: number; allowedSpecs: readonly string[] }>(
      "/api/agents",
    ),
  createAgent: (specName: string) =>
    request<AgentSummary>("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specName }),
    }),
  deleteAgent: (id: string) => request<void>(`/api/agents/${id}`, { method: "DELETE" }),
  getMessages: (id: string) => request<{ messages: unknown[] }>(`/api/agents/${id}/messages`),

  getAgentState: (id: string) => request<PiSessionState>(`/api/agents/${id}/state`),
  getAgentStats: (id: string) => request<SessionStats>(`/api/agents/${id}/stats`),
  getAgentModels: (id: string) => request<{ models: PiModel[] }>(`/api/agents/${id}/models`),
  getAgentForkPoints: (id: string) =>
    request<{ forkPoints: ForkPoint[] }>(`/api/agents/${id}/fork-points`),
  agentExportUrl: (id: string, path: string) =>
    `${API_BASE}/api/agents/${id}/export?path=${encodeURIComponent(path)}`,
};

export function wsUrl(path: string): string {
  if (API_BASE) {
    const base = new URL(API_BASE);
    const protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${base.host}${path}`;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}
