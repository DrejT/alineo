/**
 * Browser client for the alineo sandbox API (`apps/sandbox`) — the same backend the
 * standalone dashboard at sandbox.alineo.tech talks to. Every call here hits a real
 * OpenSandbox-backed sandbox: nothing is mocked or replayed.
 *
 * Endpoint is chosen by the reader (see `connection.tsx`): the hosted API by default,
 * or a local `bun run` of `apps/sandbox` for readers who ran `bunx alineo-cli init`.
 */

export const HOSTED_ENDPOINT = "https://sandbox-api.alineo.tech";
export const LOCAL_ENDPOINT = "http://localhost:3000";

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

export interface Checkpoint {
  snapshotId: string;
  tag?: string;
  createdAt: number;
}

export interface CapacityInfo {
  sandboxes: { used: number; max: number };
  agents: { used: number; max: number; allowedSpecs: readonly string[] };
}

/** One frame of a streamed `exec` — stdout as it arrives, then a single terminal frame. */
export type ExecFrame =
  | { type: "stdout"; text: string }
  | { type: "exit"; exitCode: number; stderr: string }
  | { type: "error"; message: string };

export class PlaygroundApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlaygroundApiError";
  }
}

export class PlaygroundClient {
  readonly base: string;

  constructor(endpoint: string) {
    this.base = endpoint.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, init);
    } catch (err) {
      throw new PlaygroundApiError(
        `Could not reach ${this.base} — is the sandbox server running and reachable? (${
          err instanceof Error ? err.message : String(err)
        })`,
        0,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new PlaygroundApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // --- health / capacity -------------------------------------------------------

  async health(): Promise<boolean> {
    // Hit a CORS-enabled route, not `/health` (which is a bare Response with no CORS
    // headers — a cross-origin fetch of it rejects before we can read `res.ok`).
    try {
      const res = await fetch(`${this.base}/api/sandboxes`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async capacity(): Promise<CapacityInfo> {
    const [sb, ag] = await Promise.all([
      this.request<{ sandboxes: SandboxSummary[]; max: number }>("/api/sandboxes"),
      this.request<{ agents: AgentSummary[]; max: number; allowedSpecs: readonly string[] }>(
        "/api/agents",
      ),
    ]);
    return {
      sandboxes: { used: sb.sandboxes.length, max: sb.max },
      agents: { used: ag.agents.length, max: ag.max, allowedSpecs: ag.allowedSpecs },
    };
  }

  // --- sandboxes -------------------------------------------------------------

  listSandboxes() {
    return this.request<{ sandboxes: SandboxSummary[]; max: number }>("/api/sandboxes");
  }

  createSandbox() {
    return this.request<SandboxSummary>("/api/sandboxes", { method: "POST" });
  }

  deleteSandbox(id: string) {
    return this.request<void>(`/api/sandboxes/${id}`, { method: "DELETE" });
  }

  forkSandbox(id: string, tag?: string) {
    return this.request<SandboxSummary>(`/api/sandboxes/${id}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
  }

  writeFile(id: string, path: string, content: string) {
    return this.request<{ path: string }>(
      `/api/sandboxes/${id}/file?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: content },
    );
  }

  readFile(id: string, path: string) {
    return this.request<{ path: string; content: string }>(
      `/api/sandboxes/${id}/file?path=${encodeURIComponent(path)}`,
    );
  }

  listDirectory(id: string, path: string) {
    return this.request<{ entries: FileEntry[] }>(
      `/api/sandboxes/${id}/files?path=${encodeURIComponent(path)}`,
    );
  }

  listCheckpoints(id: string) {
    return this.request<{ checkpoints: Checkpoint[] }>(`/api/sandboxes/${id}/checkpoints`);
  }

  createCheckpoint(id: string) {
    return this.request<{ snapshotId: string }>(`/api/sandboxes/${id}/checkpoint`, {
      method: "POST",
    });
  }

  /**
   * Run one command to completion, yielding stdout as it streams and finishing with a
   * terminal `exit` (or `error`) frame. Backed by `POST /api/sandboxes/:id/exec` (SSE).
   */
  async *exec(id: string, command: string, signal?: AbortSignal): AsyncGenerator<ExecFrame> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/sandboxes/${id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal,
      });
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      yield { type: "error", message: body.error ?? `${res.status} ${res.statusText}` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim()) as ExecFrame;
          } catch {
            /* skip malformed frame */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --- agents ---------------------------------------------------------------

  listAgents() {
    return this.request<{
      agents: AgentSummary[];
      max: number;
      allowedSpecs: readonly string[];
    }>("/api/agents");
  }

  createAgent(specName: string) {
    return this.request<AgentSummary>("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specName }),
    });
  }

  deleteAgent(id: string) {
    return this.request<void>(`/api/agents/${id}`, { method: "DELETE" });
  }

  /** `ws(s)://…/ws/agents/:id/chat` — bidirectional Pi session stream. */
  chatSocketUrl(id: string): string {
    const u = new URL(this.base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `/ws/agents/${id}/chat`;
    return u.toString();
  }
}
