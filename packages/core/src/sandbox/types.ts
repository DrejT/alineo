import type { ControlClient, NetworkPolicy, CodeLanguage } from "@alineo-labs/opensandbox";
import type { IStorageAdapter } from "../ledger";
import type { ExecResult } from "../exec-handle";
import type { CredentialBinding, CredentialBroker } from "../credentials";
import type { SandboxHandle } from "./sandbox";

export interface ExecOptions {
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Environment variables to set for this exec. */
  env?: Record<string, string>;
  /** Abort the command after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Throw `CommandError` if the command exits with a non-zero code.
   * Defaults to `true`.
   */
  strict?: boolean;
  /**
   * Path to the shell binary used to execute the command.
   * Overrides the sandbox-level default set in `SandboxOptions.shell`.
   * Defaults to `"/bin/sh"`.
   */
  shell?: string;
  /**
   * Open a live, bidirectional PTY session instead of running `cmd` as a
   * one-shot buffered command. `cmd` is the program to launch (e.g. `"bash"`),
   * not a script blob. Returns an `InteractiveExecHandle` with `write()`,
   * `resize()`, `signal()`, `close()`, and `attach()` in addition to the
   * usual `stdout()`/`pipe()`/`result()`/`await` surface.
   */
  interactive?: boolean;
}

/** A session still open at the last checkpoint — reconstructed on resume. See `Sandbox.resume()`. */
export interface PendingInteractiveExec {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Recorded stdin, in order — replayed for real against the freshly restored filesystem. */
  stdin: string[];
  /** Recorded stdout — shown as scrollback before live output resumes. */
  stdout: string;
}

export interface ExecCodeOptions {
  /** Execution context (stateful interpreter session). */
  context?: { id: string; language: CodeLanguage };
}

/** Lifecycle hooks for observability. Pass via `SandboxDeps.hooks`. */
export interface SandboxHooks {
  onSandboxCreated?(sandboxId: string, name: string): void;
  onExecStart?(sandboxId: string, seq: number, cmd: string): void;
  onExecComplete?(sandboxId: string, seq: number, result: ExecResult): void;
  onCheckpoint?(sandboxId: string, snapshotId: string, name?: string): void;
  onSandboxClosed?(sandboxId: string): void;
  onSandboxFailed?(sandboxId: string, error: Error): void;
  onSandboxPaused?(sandboxId: string): void;
  onSandboxResumed?(sandboxId: string): void;
  /** Fires on `sb.credentials.set()`/`.patch()` — never carries the credential value. */
  onCredentialInjected?(sandboxId: string, name: string, binding: CredentialBinding): void;
}

/** Internal dependencies injected by `Sandbox`. */
export interface SandboxDeps {
  control: ControlClient;
  adapter: IStorageAdapter;
  hooks?: SandboxHooks;
  /** Broker for `sb.credentials.*` — undefined unless the sandbox was created with `credentialProxy: true`. */
  credentialBroker?: CredentialBroker;
  /** Called when `close()` completes — used by `Sandbox` for concurrency accounting. */
  onClose?: () => void;
  /** Default shell for all `exec()` calls on this sandbox. Defaults to `"/bin/sh"`. */
  shell?: string;
  /**
   * Called by `fork()` to create a new SandboxHandle from a snapshot — injected by `Sandbox`.
   * `runId`, if passed, overrides whatever run-correlation ID this closure would otherwise
   * default to (see `fork()`'s own docs in `lifecycle.ts` for why an explicit override is
   * needed across a process boundary). `opts.resourceId`/`opts.teamId` work the same way —
   * absent, the closure falls back to whatever this sandbox's own creation captured (a
   * continuation of the same resource's memory); passed explicitly, the forked child gets a
   * *different* resource/team identity instead of inheriting this sandbox's one. Needed for
   * `Alineo.spawn()`, where the child is a semantically different agent, not a branch of the
   * same one.
   */
  fork?: (
    snapshotId: string,
    tag?: string,
    runId?: string,
    opts?: {
      networkPolicy?: NetworkPolicy;
      credentialProxy?: boolean;
      resourceId?: string;
      teamId?: string;
    },
  ) => Promise<SandboxHandle>;
  /** Route execd and proxy calls through the OpenSandbox server. Required when the server runs in Docker. */
  useServerProxy?: boolean;
}
