/**
 * The vocabulary alineo speaks to a sandbox provider.
 *
 * These types are deliberately plain: strings, numbers, and records. Nothing here names a
 * provider, and nothing here is an enum, so a provider maps its own states and events onto them
 * in one place (its adapter) and everything above stays unaware which provider it is on.
 */

// ── sandbox ──────────────────────────────────────────────────────────────────

/**
 * Where a sandbox is in its life, in alineo's words. The same word alineod uses for an agent: `state`.
 *
 * Every provider maps its own states onto these. **A state a provider cannot place becomes
 * `provisioning`, never `running`**: reporting a sandbox as running before it is hides the
 * startup deadline, and a caller that waits for `running` then times out with a reason instead
 * of acting on a sandbox that is not there.
 */
export type SandboxState =
  | "provisioning"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "stopping"
  | "terminated"
  | "failed";

export interface SandboxInfo {
  id: string;
  state: SandboxState;
  /**
   * The provider's own word for the state (`"Terminated"`, `"Running"`), for messages and logs.
   * Not for logic: branch on `state`.
   */
  nativeState?: string;
  reason?: string;
  message?: string;
  createdAt?: string;
  expiresAt?: string | null;
  metadata?: Record<string, string>;
  /** The snapshot the sandbox was created from, when it was. */
  snapshotId?: string;
}

export interface ListSandboxesFilter {
  state?: SandboxState;
  limit?: number;
  offset?: number;
}

export interface ImageSpec {
  uri: string;
  auth?: { username: string; password: string };
}

export interface Resources {
  cpu?: string;
  memory?: string;
  gpu?: string;
}

/** One ordered rule in a {@link NetworkPolicy}. `target` is an FQDN, a `*.` wildcard, an IP, or a CIDR. */
export interface NetworkRule {
  action: "allow" | "deny";
  target: string;
}

export interface NetworkPolicy {
  defaultAction?: "allow" | "deny";
  egress: NetworkRule[];
}

/** Opts a sandbox into credential injection that keeps the value outside the guest. */
export interface CredentialProxyConfig {
  enabled: boolean;
}

export interface CreateSandboxRequest {
  image?: ImageSpec;
  /** Create from a snapshot instead of an image. */
  snapshotId?: string;
  /** Lifetime in seconds. */
  timeout?: number;
  resourceLimits?: Resources;
  entrypoint?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  secureAccess?: boolean;
  networkPolicy?: NetworkPolicy;
  credentialProxy?: CredentialProxyConfig;
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export type SnapshotState = "pending" | "ready" | "failed";

export interface SnapshotInfo {
  id: string;
  sandboxId: string;
  state: SnapshotState;
  createdAt: string;
}

// ── endpoint, diagnostics ────────────────────────────────────────────────────

/** Where a port inside a sandbox can be reached from the host, and what to send with the request. */
export interface Endpoint {
  /** A URL, or `host:port`. */
  endpoint: string;
  headers?: Record<string, string>;
}

export interface DiagnosticLog {
  name: string;
  size: number;
  url?: string;
  inline?: string;
}

export interface DiagnosticEvent {
  timestamp: string;
  type: string;
  message: string;
}

// ── exec ─────────────────────────────────────────────────────────────────────

/**
 * The kinds of event a command or code execution streams. A string union, not an enum, so a
 * provider's own enum of the same values is assignable to it.
 */
export type ExecEventType =
  | "init"
  | "status"
  | "stdout"
  | "stderr"
  | "result"
  | "execution_complete"
  | "execution_count"
  | "error"
  | "ping"
  | "message";

export interface ExecEvent {
  type: ExecEventType;
  text?: string;
  results?: Record<string, string>;
  error?: {
    name?: string;
    message?: string;
    /** The exit code, as text, on a command that did not exit 0. */
    evalue?: string;
    ename?: string;
    /** For a command: `["exit status 3"]`, or `["signal: killed"]` when a signal ended it. */
    traceback?: string[];
  };
  execution_count?: number;
  execution_time?: number;
  timestamp: number;
}

/**
 * The languages a code context can run. One definition: OpenSandbox and the SDK re-export this.
 *
 * A const object and a type of the same name, so `CodeLanguage.Python` works as a value and
 * `CodeLanguage` works as a type, which is how the enum it replaces was used.
 */
export const CodeLanguage = {
  Python: "python",
  JavaScript: "javascript",
  TypeScript: "typescript",
  Go: "go",
  Java: "java",
  Bash: "bash",
} as const;
export type CodeLanguage = (typeof CodeLanguage)[keyof typeof CodeLanguage];

export interface CodeContext {
  id: string;
  language: CodeLanguage;
}

export interface ExecuteCodeRequest {
  code: string;
  context?: { id: string; language: CodeLanguage };
}

export interface ExecuteCommandRequest {
  command: string;
  cwd?: string;
  background?: boolean;
  /** Milliseconds. */
  timeout?: number;
  uid?: number;
  gid?: number;
  envs?: Record<string, string>;
}

export interface FileInfo {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  modified_at: string;
  created_at: string;
  owner: string;
  group: string;
}

export interface FileReplacement {
  path: string;
  old: string;
  new: string;
}

export interface Metrics {
  cpu: number;
  memory: number;
  timestamp: string;
}

export interface CreateSessionRequest {
  cwd?: string;
}

export interface CreateSessionResponse {
  session_id: string;
}

export interface RunInSessionRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

/**
 * What alineo does inside a running sandbox: run commands and code, and move files.
 *
 * Obtained from {@link SandboxProvider.connectExec} once the sandbox can take a connection, so
 * holding one means the sandbox is reachable.
 */
export interface ExecChannel {
  /** A copy of this channel whose requests end when `signal` aborts. */
  withSignal(signal: AbortSignal): ExecChannel;
  /** End streams this channel left open. For a sandbox that is being torn down anyway. */
  disposeConnections(): void;

  executeCommand(request: ExecuteCommandRequest): AsyncGenerator<ExecEvent>;
  executeCode(request: ExecuteCodeRequest): AsyncGenerator<ExecEvent>;
  /** Interrupt the command that is running. */
  interruptCommand(): Promise<void>;

  listContexts(language?: string): Promise<CodeContext[]>;
  createContext(language: string): Promise<CodeContext>;

  createSession(request?: CreateSessionRequest): Promise<CreateSessionResponse>;
  runInSession(sessionId: string, request: RunInSessionRequest): AsyncGenerator<ExecEvent>;
  deleteSession(sessionId: string): Promise<void>;

  getFileInfo(path: string): Promise<FileInfo>;
  deleteFile(path: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  searchFiles(pattern: string, path?: string): Promise<string[]>;
  replaceInFiles(replacements: FileReplacement[]): Promise<void>;
  uploadFile(path: string, content: Blob | BufferSource | string): Promise<void>;
  downloadFile(path: string): Promise<ReadableStream<Uint8Array>>;
  listDirectory(path: string, depth?: number): Promise<FileInfo[]>;
  createDirectory(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;

  getMetrics(): Promise<Metrics>;
  watchMetrics(): AsyncGenerator<ExecEvent>;
}

/** One live interactive terminal session. One per `exec(cmd, { interactive: true })`. */
export interface PtyChannel {
  /** Open the session and return its id. */
  create(options?: { cwd?: string; command?: string }): Promise<string>;
  /**
   * Attach to a session. `onExit` receives the real exit code, or `-1` if the connection ended
   * some other way (a network drop, a container restart). Do not read `-1` as a process exit.
   */
  connect(
    sessionId: string,
    onOutput: (chunk: string) => void,
    onExit: (exitCode: number) => void,
  ): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  signal(name: string): void;
  close(): void;
}

// ── egress ───────────────────────────────────────────────────────────────────

/** What a sandbox's egress enforcement reports back about its live policy. */
export interface EgressPolicyStatus {
  status?: string;
  mode?: string;
  enforcementMode?: string;
  policy?: NetworkPolicy | null;
}

/** Runtime control of a sandbox's outbound traffic. Present only on a provider that has it. */
export interface EgressChannel {
  patchRules(sandboxId: string, rules: NetworkRule[]): Promise<EgressPolicyStatus>;
  deleteRules(sandboxId: string, targets: string[]): Promise<EgressPolicyStatus>;
  getPolicy(sandboxId: string): Promise<EgressPolicyStatus>;
}
