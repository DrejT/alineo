import type {
  CreateSandboxRequest,
  DiagnosticEvent,
  DiagnosticLog,
  EgressChannel,
  Endpoint,
  ExecChannel,
  ListSandboxesFilter,
  PtyChannel,
  SandboxInfo,
  SnapshotInfo,
} from "./types";

/** Whether a provider can do something. `"unverified"` means it is configured to, and not proven. */
export type Capability = boolean | "unverified";

/**
 * What a provider can do, as data.
 *
 * Plain data on purpose: a CLI or a docs generator can read it without loading a provider's
 * SDK, and a spec can be checked against it before a sandbox is created.
 */
export interface ProviderCapabilities {
  /**
   * `false` when the provider cannot snapshot. Otherwise what a snapshot keeps: `filesystem`
   * (files, not processes) or `memory` (files and running processes).
   */
  snapshot: { kind: "filesystem" | "memory" } | false;
  /** `pauseSandbox` and `resumeSandbox`. */
  pause: Capability;
  /** Runtime egress rules through {@link SandboxProvider.egress}. */
  egress: Capability;
  /** Credential injection that keeps the value outside the guest. */
  credentials: Capability;
  /** An interactive terminal through {@link SandboxProvider.connectPty}. */
  pty: Capability;
  /** Stateful code contexts through {@link ExecChannel.executeCode}. */
  code: Capability;
}

export interface ProviderDescriptor {
  /** A short stable id, recorded on the ledger: `"opensandbox"`. */
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
}

/**
 * What alineo needs from a sandbox provider.
 *
 * The control side (create, get, list, delete, pause, snapshot) is one call per method. The
 * exec side is reached through {@link connectExec}, which does not return until the sandbox
 * accepts a connection, so a caller never holds a channel to a sandbox that is not there.
 *
 * Errors: a failure the caller can act on is an `AlineoError` with a code from
 * `@alineo-labs/errors` (`SANDBOX_NOT_FOUND`, `EXEC_NOT_READY`, `PROVIDER_RATE_LIMITED`). A
 * provider maps its own errors to those in its adapter.
 */
export interface SandboxProvider {
  readonly id: string;
  readonly descriptor: ProviderDescriptor;

  createSandbox(request: CreateSandboxRequest): Promise<SandboxInfo>;
  getSandbox(sandboxId: string): Promise<SandboxInfo>;
  listSandboxes(filter?: ListSandboxesFilter): Promise<SandboxInfo[]>;
  deleteSandbox(sandboxId: string): Promise<void>;
  pauseSandbox(sandboxId: string): Promise<void>;
  resumeSandbox(sandboxId: string): Promise<void>;

  createSnapshot(sandboxId: string): Promise<SnapshotInfo>;
  getSnapshot(snapshotId: string): Promise<SnapshotInfo>;

  /**
   * Where `port` inside the sandbox can be reached from the host. `useServerProxy` overrides
   * the provider's own setting for this call, for a provider that has one.
   */
  getEndpoint(sandboxId: string, port: number, useServerProxy?: boolean): Promise<Endpoint>;

  getDiagnosticLogs(sandboxId: string): Promise<DiagnosticLog[]>;
  getDiagnosticEvents(sandboxId: string): Promise<DiagnosticEvent[]>;

  /**
   * A channel to run commands and move files in the sandbox. Resolves once the sandbox accepts a
   * connection. Rejects with `EXEC_NOT_READY` (and `details.attempts`, `details.waitedMs`) when
   * it never does.
   */
  connectExec(sandboxId: string): Promise<ExecChannel>;

  /** A fresh terminal channel. Present only when `descriptor.capabilities.pty` is not `false`. */
  connectPty?(sandboxId: string): Promise<PtyChannel>;

  /** Runtime egress control. Present only when `descriptor.capabilities.egress` is not `false`. */
  readonly egress?: EgressChannel;
}
