import { AlineoError } from "@alineo-labs/errors";
import type { ErrorCode } from "@alineo-labs/errors";
import type { SnapshotState } from "./types";
import type {
  Sandbox,
  CreateSandboxOptions,
  ListSandboxesOptions,
  Snapshot,
  ListSnapshotsOptions,
  SandboxEndpoint,
  DiagnosticLog,
  DiagnosticEvent,
} from "./types";

// OpenSandbox returns snapshot state nested under status: { state }.
// We flatten it at the client boundary so callers always get a flat Snapshot.
interface RawSnapshot {
  id: string;
  sandboxId: string;
  status: { state: SnapshotState };
  createdAt: string;
}

function flattenSnapshot(raw: RawSnapshot): Snapshot {
  return {
    id: raw.id,
    sandboxId: raw.sandboxId,
    state: raw.status.state,
    createdAt: raw.createdAt,
  };
}

/**
 * Which alineo code an OpenSandbox response stands for.
 *
 * `upstreamCode` is OpenSandbox's own code (`DOCKER::SANDBOX_NOT_FOUND`), which says what the
 * server meant. The status and the route say what it means to alineo. A 404 on a sandbox route
 * is a missing sandbox even when the body carries no code.
 */
function codeForResponse(
  status: number,
  upstreamCode: string | undefined,
  path?: string,
): ErrorCode {
  if (upstreamCode?.endsWith("SANDBOX_NOT_FOUND")) return "SANDBOX_NOT_FOUND";
  if (status === 404 && path !== undefined && /^\/v1\/sandboxes\/[^/]+\/?(\?.*)?$/.test(path)) {
    return "SANDBOX_NOT_FOUND";
  }
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_ERROR";
}

/**
 * A non-2xx answer from the OpenSandbox server.
 *
 * `code` is the alineo code ({@link AlineoError}). OpenSandbox's own code, when the response
 * carried one, is `upstreamCode`.
 */
export class OpenSandboxError extends AlineoError {
  constructor(
    message: string,
    public readonly status: number,
    /** OpenSandbox's error code, e.g. `DOCKER::SANDBOX_NOT_FOUND`, when the response carried one. */
    public readonly upstreamCode?: string,
    code?: ErrorCode,
    path?: string,
  ) {
    super(code ?? codeForResponse(status, upstreamCode, path), message, {
      details: { status, ...(upstreamCode ? { upstreamCode } : {}) },
    });
    this.name = "OpenSandboxError";
  }
}

/**
 * OpenSandbox answers an error with a JSON body, `{"code": "...", "message": "..."}`. Put the
 * sentence in `message` (with the code after it), keep the code on `.upstreamCode`, and fall back
 * to the raw text when the body isn't that shape.
 */
function errorFromBody(text: string, status: number, path?: string): OpenSandboxError {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
    if (typeof body?.message === "string" && body.message) {
      const upstream = typeof body.code === "string" && body.code ? body.code : undefined;
      return new OpenSandboxError(
        upstream ? `${body.message} (${upstream})` : body.message,
        status,
        upstream,
        undefined,
        path,
      );
    }
  } catch {
    // not JSON: use the raw text below
  }
  return new OpenSandboxError(text || "OpenSandbox API error", status, undefined, undefined, path);
}

export class ControlClient {
  private baseUrl: string;
  private apiKey: string;
  private signal?: AbortSignal;

  constructor(options: { baseUrl: string; apiKey: string; signal?: AbortSignal }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.signal = options.signal;
  }

  /** Return a new `ControlClient` instance that passes `signal` to every fetch call. */
  withSignal(signal: AbortSignal): ControlClient {
    return new ControlClient({ baseUrl: this.baseUrl, apiKey: this.apiKey, signal });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "OPEN-SANDBOX-API-KEY": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw errorFromBody(text, res.status, path);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  createSandbox(options: CreateSandboxOptions): Promise<Sandbox> {
    return this.request("POST", "/v1/sandboxes", options);
  }

  /**
   * Every sandbox, optionally filtered by state. OpenSandbox paginates with `page`/`pageSize`
   * (default 20, max 200) and ignores `limit`/`offset`, so this walks every page and applies
   * `offset`/`limit` itself. Sending `limit`/`offset` as query parameters silently capped every
   * listing at the server's first 20.
   */
  async listSandboxes(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const all: Sandbox[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ page: String(page), pageSize: "200" });
      if (options.state) params.set("state", options.state);
      const res = await this.request<{ items: Sandbox[]; pagination?: { hasNextPage?: boolean } }>(
        "GET",
        `/v1/sandboxes?${params}`,
      );
      all.push(...res.items);
      if (!res.pagination?.hasNextPage) break;
    }
    const start = options.offset ?? 0;
    return all.slice(start, options.limit === undefined ? undefined : start + options.limit);
  }

  getSandbox(id: string): Promise<Sandbox> {
    return this.request("GET", `/v1/sandboxes/${id}`);
  }

  deleteSandbox(id: string): Promise<void> {
    return this.request("DELETE", `/v1/sandboxes/${id}`);
  }

  pauseSandbox(id: string): Promise<void> {
    return this.request("POST", `/v1/sandboxes/${id}/pause`);
  }

  resumeSandbox(id: string): Promise<void> {
    return this.request("POST", `/v1/sandboxes/${id}/resume`);
  }

  /**
   * Move a sandbox's expiry to `expiresAt`, which must be in the future and later than its current
   * expiry. Only meaningful for a sandbox created with a `timeout`: one created without it never
   * expires (OpenSandbox's `CreateSandboxRequest.timeout` — "when omitted or null, the sandbox will
   * not auto-terminate"). The countdown keeps running while a sandbox is paused.
   */
  renewExpiration(id: string, expiresAt: Date | string): Promise<void> {
    const at = typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString();
    return this.request("POST", `/v1/sandboxes/${id}/renew-expiration`, { expiresAt: at });
  }

  // Returns { endpoint, headers: { "X-EXECD-ACCESS-TOKEN": "..." } }
  getEndpoint(sandboxId: string, port: number, useServerProxy?: boolean): Promise<SandboxEndpoint> {
    const qs = useServerProxy ? "?use_server_proxy=true" : "";
    return this.request("GET", `/v1/sandboxes/${sandboxId}/endpoints/${port}${qs}`);
  }

  getDiagnosticLogs(sandboxId: string): Promise<DiagnosticLog[]> {
    return this.request("GET", `/v1/sandboxes/${sandboxId}/diagnostics/logs`);
  }

  getDiagnosticEvents(sandboxId: string): Promise<DiagnosticEvent[]> {
    return this.request("GET", `/v1/sandboxes/${sandboxId}/diagnostics/events`);
  }

  async createSnapshot(sandboxId: string): Promise<Snapshot> {
    const raw = await this.request<RawSnapshot>("POST", `/v1/sandboxes/${sandboxId}/snapshots`);
    return flattenSnapshot(raw);
  }

  async listSnapshots(options: ListSnapshotsOptions = {}): Promise<Snapshot[]> {
    const params = new URLSearchParams();
    if (options.sandboxId) params.set("sandboxId", options.sandboxId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const qs = params.toString();
    const res = await this.request<{ items: RawSnapshot[] }>(
      "GET",
      `/v1/snapshots${qs ? `?${qs}` : ""}`,
    );
    return res.items.map(flattenSnapshot);
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    const raw = await this.request<RawSnapshot>("GET", `/v1/snapshots/${id}`);
    return flattenSnapshot(raw);
  }

  deleteSnapshot(id: string): Promise<void> {
    return this.request("DELETE", `/v1/snapshots/${id}`);
  }
}
