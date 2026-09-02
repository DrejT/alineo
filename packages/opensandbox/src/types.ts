export interface Resources {
  cpu?: string;
  memory?: string;
  gpu?: string;
}

export interface ImageAuth {
  username: string;
  password: string;
}

export interface ImageSpec {
  uri: string;
  auth?: ImageAuth;
}

export enum SandboxState {
  Pending = "Pending",
  Running = "Running",
  Pausing = "Pausing",
  Paused = "Paused",
  Resuming = "Resuming",
  Stopping = "Stopping",
  Terminated = "Terminated",
  Failed = "Failed",
  Unknown = "Unknown",
}

export interface SandboxStatus {
  state: SandboxState;
  reason?: string;
  message?: string;
  lastTransitionAt?: string;
}

export interface Sandbox {
  id: string;
  status: SandboxStatus;
  createdAt: string;
  expiresAt?: string | null;
  image?: ImageSpec;
  snapshotId?: string;
  entrypoint?: string[];
  metadata?: Record<string, string>;
  platform?: unknown;
}

/**
 * A single ordered rule in a `NetworkPolicy`. `target` is one of:
 * - an FQDN (`"api.github.com"`) or wildcard domain (`"*.openai.com"`) — matched against the
 *   DNS query name;
 * - a bare IPv4/IPv6 address (`"10.0.0.5"`) or CIDR block (`"10.0.0.0/8"`) — enforced at the
 *   nftables layer, so it only takes effect when the server runs `egress.mode = "dns+nft"`,
 *   and it gates raw-IP egress only. It does **not** authorize resolving a *domain* that
 *   happens to resolve into that range — use a domain rule for reach-by-name.
 */
export interface NetworkRule {
  action: "allow" | "deny";
  target: string;
}

/**
 * Outbound network policy for a sandbox, enforced by its egress sidecar. Requires the
 * OpenSandbox server to have `egress.image` configured — see `alineo init`'s generated
 * `server.toml`. `defaultAction` defaults server-side to `"deny"` if omitted.
 */
export interface NetworkPolicy {
  defaultAction?: "allow" | "deny";
  egress: NetworkRule[];
}

/**
 * Opts a sandbox into transparent MITM credential injection via the egress sidecar's
 * Credential Vault (OSEP-0012). Requires `networkPolicy` to also be set and the server to be
 * running `egress.mode = "dns+nft"` — see `@alineo-labs/vault`.
 */
export interface CredentialProxyConfig {
  enabled: boolean;
}

export interface CreateSandboxOptions {
  image?: ImageSpec;
  snapshotId?: string;
  timeout?: number;
  resourceLimits?: Resources;
  entrypoint?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  secureAccess?: boolean;
  networkPolicy?: NetworkPolicy;
  credentialProxy?: CredentialProxyConfig;
}

export interface ListSandboxesOptions {
  state?: SandboxState;
  limit?: number;
  offset?: number;
}

export enum SnapshotState {
  Pending = "Pending",
  Committing = "Committing",
  Pushing = "Pushing",
  Ready = "Ready",
  Failed = "Failed",
}

export interface Snapshot {
  id: string;
  sandboxId: string;
  state: SnapshotState;
  createdAt: string;
}

export interface ListSnapshotsOptions {
  sandboxId?: string;
  limit?: number;
  offset?: number;
}

// GET /v1/sandboxes/:id/endpoints/:port response
export interface SandboxEndpoint {
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

export enum SSEEventType {
  Init = "init",
  Status = "status",
  Stdout = "stdout",
  Stderr = "stderr",
  Result = "result",
  ExecutionComplete = "execution_complete",
  ExecutionCount = "execution_count",
  Error = "error",
  Ping = "ping",
  Message = "message",
}

export interface SSEEvent {
  type: SSEEventType;
  text?: string;
  results?: Record<string, string>;
  error?: { name?: string; message: string; evalue?: string };
  execution_count?: number;
  execution_time?: number;
  timestamp: number;
}

export enum CodeLanguage {
  Python = "python",
  JavaScript = "javascript",
  TypeScript = "typescript",
  Go = "go",
  Java = "java",
  Bash = "bash",
}

export interface CodeContext {
  id: string;
  language: CodeLanguage;
}

// POST /code body
export interface ExecuteCodeOptions {
  code: string;
  context?: {
    id: string;
    language: CodeLanguage;
  };
}

// POST /command body
export interface ExecuteCommandOptions {
  command: string;
  cwd?: string;
  background?: boolean;
  timeout?: number;
  uid?: number;
  gid?: number;
  envs?: Record<string, string>;
}

export interface CommandStatus {
  session: string;
  status: "running" | "completed" | "failed";
  exitCode?: number;
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

export interface RunInSessionRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface CreateSessionResponse {
  session_id: string;
}

// POST /pty body
export interface CreatePtyOptions {
  cwd?: string;
  command?: string;
}

export interface CreatePtyResponse {
  session_id: string;
}

// Client -> server WS control frames for a /pty/:sessionId/ws connection
export type PtyClientMessage =
  | { type: "stdin"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: string }
  | { type: "ping" };

// Server -> client JSON control frames (output itself arrives as binary frames)
export type PtyServerMessage =
  | { type: "exit"; exit_code: number }
  | { type: "pong" }
  | { type: "connected"; session_id: string; mode: string };
