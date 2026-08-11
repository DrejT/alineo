import { SSEEventType } from "./types";
import type {
  SSEEvent,
  CodeContext,
  ExecuteCodeOptions,
  ExecuteCommandOptions,
  CommandStatus,
  FileInfo,
  FileReplacement,
  Metrics,
  CreateSessionRequest,
  RunInSessionRequest,
  CreateSessionResponse,
} from "./types";

/**
 * `isTerminal` lets one-shot command/code streams cancel the underlying
 * connection as soon as their terminal event arrives, instead of reading to
 * EOF: execd holds the HTTP stream open for a fixed interval after the last
 * event is sent (a server-side post-completion sleep — see
 * opensandbox-group/OpenSandbox#1277: `/command`'s handler does a blind
 * `time.Sleep` instead of signalling completion the way `/code` and
 * `/session/:id/run` do), so waiting for `done` tacks that delay onto every
 * exec. Long-lived streams (metrics watch) pass no predicate and read until
 * the server actually closes the connection.
 *
 * `pendingReaders` lets the owning `ExecClient` force these dangling readers
 * shut later (see `disposeConnections()`) instead of leaving them open until
 * the server's own delayed close — see that method's doc comment for why.
 */
async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  pendingReaders: Set<ReadableStreamDefaultReader<Uint8Array>>,
  isTerminal?: (event: SSEEvent) => boolean,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  pendingReaders.add(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  let terminatedEarly = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        let event: SSEEvent | undefined;
        if (trimmed.startsWith("{")) {
          // execd sends raw JSON lines, not data:-prefixed SSE
          try {
            event = JSON.parse(trimmed) as SSEEvent;
          } catch {
            continue; // skip malformed
          }
        } else {
          let type: string | undefined;
          let data: string | undefined;
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data !== undefined) {
            event = { type: (type ?? SSEEventType.Message) as SSEEventType, ...JSON.parse(data) };
          }
        }
        if (!event) continue;
        yield event;
        if (isTerminal?.(event)) {
          // Deliberately don't reader.cancel() here — that aborts the connection
          // immediately, and some server-side proxies (e.g. OpenSandbox's Python
          // control server relaying execd's response via httpx) treat a mid-stream
          // client abort as a broken upstream read and throw. Just stop reading:
          // we resolve now either way, and the server closes the connection on
          // its own terms shortly after (see the comment on parseSSE above).
          //
          // That "shortly after" is exactly execd's fixed post-completion sleep
          // (OpenSandbox#1277 again), so the reader is left registered in
          // `pendingReaders` — still holding its lock, not released — rather than
          // released here, so `disposeConnections()` can still reach it and force
          // the underlying connection shut once nobody cares if the proxy's relay
          // of execd's still-open response errors out.
          terminatedEarly = true;
          return;
        }
      }
    }
  } finally {
    if (!terminatedEarly) {
      pendingReaders.delete(reader);
      reader.releaseLock();
    }
  }
}

function isExecTerminal(event: SSEEvent): boolean {
  return event.type === SSEEventType.ExecutionComplete || event.type === SSEEventType.Error;
}

export class ExecClient {
  private baseUrl: string;
  private accessToken: string;
  private signal?: AbortSignal;
  /** Readers left dangling by `parseSSE`'s early-return optimization — see `disposeConnections()`. */
  private pendingReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  constructor(options: { baseUrl?: string; accessToken: string; signal?: AbortSignal }) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:44772").replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.signal = options.signal;
  }

  /** Return a new `ExecClient` instance that passes `signal` to every fetch call. */
  withSignal(signal: AbortSignal): ExecClient {
    return new ExecClient({ baseUrl: this.baseUrl, accessToken: this.accessToken, signal });
  }

  /**
   * Force-cancel any exec streams `parseSSE` deliberately left open (its early return
   * on `isTerminal`, to dodge OpenSandbox#1277's proxy behavior — see its comment).
   * Those connections sit ESTABLISHED, keeping Bun's event loop alive, until execd's
   * own fixed post-completion sleep elapses server-side; calling this once the sandbox
   * is being torn down anyway (e.g. from `Sandbox.close()`) skips that wait instead of
   * leaving the process to hang on whichever exec's delay hadn't yet elapsed.
   */
  disposeConnections(): void {
    for (const reader of this.pendingReaders) reader.cancel().catch(() => {});
    this.pendingReaders.clear();
  }

  private get authHeader(): Record<string, string> {
    return { "X-EXECD-ACCESS-TOKEN": this.accessToken };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.authHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `execd error ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async *streamRequest(
    method: string,
    path: string,
    body?: unknown,
    isTerminal?: (event: SSEEvent) => boolean,
  ): AsyncGenerator<SSEEvent> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.authHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `execd error ${res.status}`);
    }
    if (!res.body) return;
    yield* parseSSE(res.body, this.pendingReaders, isTerminal);
  }

  ping(): Promise<{ status: string }> {
    return this.request("GET", "/ping");
  }

  listContexts(language?: string): Promise<CodeContext[]> {
    const qs = language ? `?language=${encodeURIComponent(language)}` : "";
    return this.request("GET", `/code/contexts${qs}`);
  }

  clearContexts(language?: string): Promise<void> {
    const qs = language ? `?language=${encodeURIComponent(language)}` : "";
    return this.request("DELETE", `/code/contexts${qs}`);
  }

  deleteContext(contextId: string): Promise<void> {
    return this.request("DELETE", `/code/contexts/${contextId}`);
  }

  createContext(language: string): Promise<CodeContext> {
    return this.request("POST", "/code/context", { language });
  }

  async *executeCode(options: ExecuteCodeOptions): AsyncGenerator<SSEEvent> {
    yield* this.streamRequest("POST", "/code", options, isExecTerminal);
  }

  interruptCode(): Promise<void> {
    return this.request("DELETE", "/code");
  }

  async *executeCommand(options: ExecuteCommandOptions): AsyncGenerator<SSEEvent> {
    yield* this.streamRequest("POST", "/command", options, isExecTerminal);
  }

  interruptCommand(): Promise<void> {
    return this.request("DELETE", "/command");
  }

  getCommandStatus(session: string): Promise<CommandStatus> {
    return this.request("GET", `/command/status/${session}`);
  }

  getCommandOutput(session: string): Promise<{ stdout: string; stderr: string }> {
    return this.request("GET", `/command/output/${session}`);
  }

  async getFileInfo(path: string): Promise<FileInfo> {
    const map = await this.request<Record<string, FileInfo>>(
      "GET",
      `/files/info?path=${encodeURIComponent(path)}`,
    );
    const entry = map[path];
    if (!entry) throw new Error(`getFileInfo: no entry for path ${path}`);
    return entry;
  }

  deleteFile(path: string): Promise<void> {
    return this.request("DELETE", `/files?path=${encodeURIComponent(path)}`);
  }

  setPermissions(path: string, mode: string): Promise<void> {
    return this.request("POST", "/files/permissions", { [path]: { mode: parseInt(mode, 10) } });
  }

  moveFile(from: string, to: string): Promise<void> {
    return this.request("POST", "/files/mv", [{ src: from, dest: to }]);
  }

  async searchFiles(pattern: string, path: string = "/"): Promise<string[]> {
    const params = new URLSearchParams({ path, pattern });
    const entries = await this.request<FileInfo[]>("GET", `/files/search?${params}`);
    return entries.map((e) => e.path);
  }

  replaceInFiles(replacements: FileReplacement[]): Promise<void> {
    const body: Record<string, { old: string; new: string }> = {};
    for (const r of replacements) body[r.path] = { old: r.old, new: r.new };
    return this.request("POST", "/files/replace", body);
  }

  async uploadFile(path: string, content: Blob | BufferSource | string): Promise<void> {
    // execd requires File objects (not Blob) so Content-Disposition includes a filename attribute.
    const formData = new FormData();
    formData.append(
      "metadata",
      new File([JSON.stringify({ path })], "metadata.json", { type: "application/json" }),
    );
    formData.append(
      "file",
      new File([content], path.split("/").pop() ?? "file", { type: "application/octet-stream" }),
    );
    const res = await fetch(`${this.baseUrl}/files/upload`, {
      method: "POST",
      headers: this.authHeader,
      body: formData,
      signal: this.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `execd error ${res.status}`);
    }
  }

  async downloadFile(path: string): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${this.baseUrl}/files/download?path=${encodeURIComponent(path)}`, {
      headers: this.authHeader,
      signal: this.signal,
    });
    if (!res.ok) throw new Error(`execd error ${res.status}`);
    if (!res.body) throw new Error("empty response body");
    return res.body;
  }

  listDirectory(path: string, depth?: number): Promise<FileInfo[]> {
    const params = new URLSearchParams({ path });
    if (depth !== undefined) params.set("depth", String(depth));
    return this.request("GET", `/directories/list?${params}`);
  }

  createDirectory(path: string): Promise<void> {
    return this.request("POST", "/directories", { [path]: { mode: 755 } });
  }

  deleteDirectory(path: string): Promise<void> {
    return this.request("DELETE", `/directories?path=${encodeURIComponent(path)}`);
  }

  getMetrics(): Promise<Metrics> {
    return this.request("GET", "/metrics");
  }

  async *watchMetrics(): AsyncGenerator<SSEEvent> {
    yield* this.streamRequest("GET", "/metrics/watch");
  }

  createSession(opts?: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.request("POST", "/session", opts ?? {});
  }

  async *runInSession(sessionId: string, opts: RunInSessionRequest): AsyncGenerator<SSEEvent> {
    yield* this.streamRequest("POST", `/session/${sessionId}/run`, opts, isExecTerminal);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request("DELETE", `/session/${sessionId}`);
  }
}
