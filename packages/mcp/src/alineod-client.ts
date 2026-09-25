/**
 * Thin HTTP + SSE client for alineod's wire contract. Still typed against the contract rather
 * than against the daemon's internals — alineod is "standalone by design" (its own README) and
 * this package talks to it the way any external MCP client would, over HTTP. The difference is
 * that the contract is now a published package (`@alineo-labs/schema/alineod`) instead of an
 * app's source file, so honouring that boundary no longer costs a second copy of every shape.
 *
 * `spec` fields below stay `Record<string, unknown>`, not `AgentSpec` — an MCP tool receives
 * arbitrary unvalidated JSON from a model, and typing it as an `AgentSpec` would claim a
 * guarantee this side of the wire cannot make. alineod validates it for real now (its wire
 * schema is `@alineo-labs/schema`'s `AgentSpecSchema`, no longer an opaque record), so an
 * invalid spec comes back as a 400 naming the bad field rather than failing later inside
 * `Alineo.start()`.
 *
 * The interfaces below still mirror alineod's wire contract by hand. Now that the contract
 * itself is a published package, pointing them at it would delete that duplication — the
 * original reason not to (alineod's schemas being internal) no longer holds.
 */

export class AlineodError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AlineodError";
  }
}

// The wire contract, from the package that defines it. These were eleven hand-written
// interfaces mirroring alineod's Zod schemas — deliberate while those schemas were an app's
// internals, and no longer defensible now the contract is published as
// `@alineo-labs/schema/alineod`. Nothing checked that the two agreed, which is the whole
// argument against keeping them.
//
// `spec` stays `Record<string, unknown>` on the way in: an MCP tool receives arbitrary
// unvalidated JSON from a model, and typing it as `AgentSpec` here would claim a guarantee
// this side of the wire cannot make. alineod validates it for real and answers with a 400
// naming the bad field.
import type { z } from "zod";
import type {
  AgentDetail as AgentDetailSchema,
  AgentView as AgentViewSchema,
  BudgetOverride as BudgetOverrideSchema,
  CreateRunResponse as CreateRunResponseSchema,
  ResultResponse as ResultResponseSchema,
  SpawnAgentResponse as SpawnAgentResponseSchema,
  TreeView as TreeViewSchema,
} from "@alineo-labs/schema/alineod";

export type BudgetOverride = z.infer<typeof BudgetOverrideSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type SpawnAgentResponse = z.infer<typeof SpawnAgentResponseSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export type TreeView = z.infer<typeof TreeViewSchema>;
export type ResultResponse = z.infer<typeof ResultResponseSchema>;

/**
 * The two request bodies keep `spec: Record<string, unknown>` rather than reusing the wire
 * schema's `AgentSpec`, for the reason above. Everything else about them comes from the
 * contract.
 */
export interface CreateRunBody {
  spec: Record<string, unknown>;
  prompt?: string;
  budget?: BudgetOverride;
}

export interface SpawnAgentBody {
  spec: Record<string, unknown>;
  parentAgentId: string;
  waitFor?: string[];
  prompt?: string;
  budget?: BudgetOverride;
  idempotencyKey?: string;
}

/** An SSE frame off `GET /runs/:runId/events`. Not a schema — it is the transport's shape. */
export interface AlineodSseEvent {
  id?: number;
  event: string;
  data: unknown;
}

export interface AlineodClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4600";

export class AlineodClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AlineodClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ALINEOD_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new AlineodError(
        0,
        `Could not reach alineod at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Is it running? Try the init tool, or set ALINEOD_URL.`,
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const data = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const message = (data as { error?: string } | undefined)?.error ?? res.statusText;
      throw new AlineodError(res.status, message);
    }
    return data as T;
  }

  createRun(body: CreateRunBody): Promise<CreateRunResponse> {
    return this.request("POST", "/runs", body);
  }

  getRun(runId: string): Promise<TreeView> {
    return this.request("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  deleteRun(runId: string): Promise<void> {
    return this.request("DELETE", `/runs/${encodeURIComponent(runId)}`);
  }

  spawnAgent(runId: string, body: SpawnAgentBody): Promise<SpawnAgentResponse> {
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/agents`, body);
  }

  getAgent(agentId: string): Promise<AgentDetail> {
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}`);
  }

  promptAgent(agentId: string, text: string): Promise<void> {
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/prompt`, { text });
  }

  steerAgent(agentId: string, message: string): Promise<void> {
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/steer`, { message });
  }

  pauseAgent(agentId: string): Promise<void> {
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/pause`);
  }

  resumeAgent(agentId: string): Promise<void> {
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/resume`);
  }

  stopAgent(agentId: string, mode?: "abort" | "drain"): Promise<void> {
    return this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/stop`,
      mode ? { mode } : undefined,
    );
  }

  getResult(agentId: string, waitSeconds?: number): Promise<ResultResponse> {
    const qs = waitSeconds ? `?wait=${encodeURIComponent(String(waitSeconds))}` : "";
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/result${qs}`);
  }

  /**
   * Collects SSE events from `/runs/:runId/events` for at most `maxWaitMs` (default 20s, capped
   * at 120s) or until `maxEvents` (default 50) have been read, whichever comes first — an MCP
   * tool call is request/response, so this turns the daemon's open-ended stream into a bounded
   * poll-and-collect instead of hanging the connection indefinitely.
   */
  async watchEvents(
    runId: string,
    opts: { sinceEventId?: number; maxWaitMs?: number; maxEvents?: number } = {},
  ): Promise<AlineodSseEvent[]> {
    const maxWaitMs = Math.min(opts.maxWaitMs ?? 20_000, 120_000);
    const maxEvents = opts.maxEvents ?? 50;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, maxWaitMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { "last-event-id": String(opts.sinceEventId ?? 0) },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") return [];
      throw new AlineodError(
        0,
        `Could not reach alineod at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new AlineodError(res.status, `Failed to open event stream (${res.status})`);
    }

    const events: AlineodSseEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (events.length < maxEvents) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) events.push(parsed);
          if (events.length >= maxEvents) break;
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) throw err;
    } finally {
      clearTimeout(timer);
      controller.abort();
      reader.releaseLock();
    }
    return events;
  }
}

function parseSseFrame(frame: string): AlineodSseEvent | null {
  let id: number | undefined;
  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || undefined;
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = dataLines.join("\n");
  }
  return { id, event, data };
}
