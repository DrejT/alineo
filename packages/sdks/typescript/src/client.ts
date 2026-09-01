import {
  SandboxHandle,
  LedgerEvent,
  type IStorageAdapter,
  type SandboxDetails,
  type ListSandboxOptions,
  type ExecResult,
  type EnvironmentRecord,
  type PendingInteractiveExec,
  type CredentialBroker,
  type CredentialResolver,
} from "@alineo-labs/core";
import {
  reconstructBoundCredentials,
  reconstructEgressRules,
  resolveBoundCredential,
} from "@alineo-labs/core";
import {
  ControlClient,
  SandboxState,
  SnapshotState,
  isValidEgressTarget,
} from "@alineo-labs/opensandbox";
import type { NetworkPolicy } from "@alineo-labs/opensandbox";
import { OpenSandboxCredentialBroker } from "@alineo-labs/vault";

import {
  SandboxClientError,
  type SandboxClientOptions,
  type SandboxOptions,
  type ResumeOptions,
} from "./types";
import {
  Environment,
  type EnvironmentOptions,
  type EnvironmentSandboxOptions,
} from "./environment";

export { SandboxHandle, BashSession } from "@alineo-labs/core";
export type {
  ExecHandle,
  InteractiveExecHandle,
  ExecResult,
  ExecOptions,
  ExecCodeOptions,
  PendingInteractiveExec,
} from "@alineo-labs/core";
export {
  LedgerEvent,
  SandboxStatus,
  SandboxError,
  ExecConnectionError,
  CommandError,
  StepTimeoutError,
} from "@alineo-labs/core";
export type {
  IStorageAdapter,
  SandboxDetails,
  ListSandboxOptions,
  LedgerEntry,
  EnvironmentRecord,
  FileInfo,
  DiagnosticLog,
  DiagnosticEvent,
  Metrics,
  CredentialBroker,
  CredentialBinding,
} from "@alineo-labs/core";
export type { NetworkPolicy, NetworkRule, CredentialProxyConfig } from "@alineo-labs/opensandbox";
export { OpenSandboxCredentialBroker } from "@alineo-labs/vault";
export {
  SandboxClientError,
  type SandboxClientOptions,
  type SandboxOptions,
  type ResumeOptions,
} from "./types";
export type { CheckpointInfo } from "@alineo-labs/core";
export {
  Environment,
  type EnvironmentOptions,
  type EnvironmentSandboxOptions,
} from "./environment";

/**
 * Reject a `networkPolicy` with a malformed `target` before it reaches the server — a fast
 * local error instead of a round-trip. `undefined` policies pass through untouched.
 */
function assertValidNetworkPolicy(policy: NetworkPolicy | undefined): void {
  if (!policy) return;
  for (const rule of policy.egress ?? []) {
    if (!isValidEgressTarget(rule.target)) {
      throw new SandboxClientError(
        `Invalid networkPolicy egress target ${JSON.stringify(rule.target)} — expected an ` +
          `FQDN, a "*."-prefixed wildcard domain, a bare IP address, or a CIDR block.`,
        400,
      );
    }
  }
}

/**
 * Main entry point for the sandbox client. Manages sandbox lifecycle and session history.
 *
 * @example
 * ```ts
 * import { Sandbox } from "@alineo-labs/sandbox";
 * import { SQLiteAdapter } from "@alineo-labs/sqlite";
 *
 * const client = new Sandbox({
 *   baseUrl: "http://localhost:8080",
 *   adapter: new SQLiteAdapter("./alineo.db"),
 * });
 *
 * const sb = await client.sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } });
 * await sb.exec("npm ci");
 * await sb.checkpoint();
 * await sb.exec("npm test").pipe(process.stdout);
 * await sb.close();
 * ```
 */
export class Sandbox {
  private readonly _control: ControlClient;
  private readonly _adapter: IStorageAdapter;
  private readonly _credentialBroker: CredentialBroker;
  private readonly _maxConcurrency: number | undefined;
  private readonly _useServerProxy: boolean;
  private _activeCount = 0;
  private readonly _waiters: Array<() => void> = [];
  private _connectPromise: Promise<void> | null = null;
  private _adapterClosed = false;
  private readonly _envBuilds = new Map<string, Promise<string>>();

  constructor(options: SandboxClientOptions) {
    this._control = new ControlClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey ?? "",
    });
    this._adapter = options.adapter;
    this._maxConcurrency = options.maxConcurrency;
    this._useServerProxy = options.useServerProxy ?? false;
    this._credentialBroker =
      options.credentialBroker ??
      new OpenSandboxCredentialBroker(this._control, this._useServerProxy);

    // Close the adapter when the event loop drains naturally (scripts, short-lived processes).
    // Long-running servers never reach beforeExit, so Postgres pools stay alive for the
    // lifetime of the process — which is the correct behaviour.
    process.setMaxListeners(process.getMaxListeners() + 1);
    process.on("beforeExit", () => {
      if (!this._adapterClosed) {
        this._adapterClosed = true;
        void this._adapter.close?.();
      }
    });
  }

  /** Lazily initialises the adapter on first use. Concurrent callers share the same promise. */
  private _ensureConnected(): Promise<void> {
    this._connectPromise ??= this._adapter.connect?.() ?? Promise.resolve();
    return this._connectPromise;
  }

  /**
   * Create a new sandbox container and return a live `SandboxHandle` object.
   *
   * Waits until the container reaches `Running` state before returning.
   * Call `sb.close()` when done to release resources (use try/finally).
   *
   * @example
   * ```ts
   * const sb = await client.sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } });
   * try {
   *   await sb.exec("npm ci");
   *   await sb.exec("npm test").pipe(process.stdout);
   * } finally {
   *   await sb.close();
   * }
   * ```
   */
  async sandbox(opts: SandboxOptions): Promise<SandboxHandle> {
    assertValidNetworkPolicy(opts.networkPolicy);
    await this._ensureConnected();
    await this._acquireSlot();

    const image = typeof opts.image === "string" ? { uri: opts.image } : opts.image;
    const runId = opts.runId ?? crypto.randomUUID();
    const resourceId = opts.resourceId;
    const teamId = opts.teamId;

    let sandboxId: string;
    try {
      const rawSb = await this._control.createSandbox({
        image,
        env: opts.env,
        // runId also rides along in the control-plane's own metadata (echoed back by
        // GET /v1/sandboxes), not just the ledger — the ledger alone can't correlate
        // sandboxes across separate adapter instances (e.g. a forked child writing to
        // its own in-container ledger file), but the control plane is one shared
        // service every caller talks to regardless of which adapter they're using.
        metadata: { ...opts.metadata, runId },
        entrypoint: opts.entrypoint ?? ["tail", "-f", "/dev/null"],
        resourceLimits: opts.resources,
        timeout: opts.timeout,
        networkPolicy: opts.networkPolicy,
        credentialProxy: opts.credentialProxy ? { enabled: true } : undefined,
      });
      sandboxId = rawSb.id;

      await this._waitForRunning(sandboxId);

      const name = opts.name ?? `sandbox-${sandboxId.slice(0, 8)}`;
      await this._adapter.append({
        ts: Date.now(),
        name,
        sandboxId,
        stepIndex: -1,
        event: LedgerEvent.SandboxCreated,
        payload: {
          sandboxId,
          resources: opts.resources,
          runId,
          resourceId,
          teamId,
          networkPolicy: opts.networkPolicy,
          credentialProxy: opts.credentialProxy,
        },
      });

      const sb = new SandboxHandle(sandboxId, name, {
        control: this._control,
        adapter: this._adapter,
        credentialBroker: this._credentialBroker,
        hooks: opts.hooks,
        onClose: () => {
          this._releaseSlot();
        },
        shell: opts.shell,
        fork: (snapshotId, tag, overrideRunId, forkOpts) =>
          this._forkFromSnapshot(
            snapshotId,
            name,
            opts.resources,
            opts.shell,
            overrideRunId ?? runId,
            sandboxId,
            resourceId,
            teamId,
            forkOpts,
          ),
        useServerProxy: this._useServerProxy,
      });
      opts.hooks?.onSandboxCreated?.(sandboxId, name);
      return sb;
    } catch (err) {
      this._releaseSlot();
      throw err;
    }
  }

  /**
   * Resume a sandbox session from its last checkpoint.
   *
   * Restores an OpenSandbox container from the snapshot captured by the most
   * recent `sb.checkpoint()` call. Execs that completed before the checkpoint
   * are returned from ledger cache without re-running; subsequent execs run
   * against the restored container.
   *
   * @example
   * ```ts
   * // original session (crashed mid-test)
   * const sb = await client.sandbox({ image: "node:22", name: "ci", resources: { cpu: "500m", memory: "256Mi" } });
   * await sb.exec("npm ci");
   * await sb.checkpoint();
   * await sb.exec("npm test");  // container dies here
   *
   * // resume later
   * const sb2 = await client.resume(originalSessionId);
   * await sb2.exec("npm ci");    // instant — replayed from ledger
   * await sb2.exec("npm test");  // actually runs on restored container
   * await sb2.close();
   * ```
   */
  async resume(sandboxId: string, opts?: ResumeOptions): Promise<SandboxHandle> {
    await this._ensureConnected();
    const allSessions = await this._adapter.listAllSandboxDetails();
    const session = allSessions.find((s) => s.sandboxId === sandboxId);
    if (!session) throw new SandboxClientError(`Session ${sandboxId} not found`, 404);

    return this._resumeSession(session.name, sandboxId, opts?.tag, opts?.resolveCredential);
  }

  private async _resumeSession(
    name: string,
    sandboxId: string,
    tag?: string,
    resolveCredential?: CredentialResolver,
  ): Promise<SandboxHandle> {
    const entries = await this._adapter.readAll(name, sandboxId);

    let checkpointIdx: number;
    if (tag) {
      checkpointIdx = entries.findIndex(
        (e) =>
          e.event === LedgerEvent.CheckpointCreated &&
          (e.payload as { name?: string } | undefined)?.name === tag,
      );
      if (checkpointIdx === -1)
        throw new SandboxClientError(
          `No checkpoint with tag '${tag}' found for session ${sandboxId}`,
          404,
        );
    } else {
      checkpointIdx = entries.map((e) => e.event).lastIndexOf(LedgerEvent.CheckpointCreated);
      if (checkpointIdx === -1)
        throw new SandboxClientError(`No checkpoint found for session ${sandboxId}`, 404);
    }

    const { snapshotId } = entries[checkpointIdx].payload as { snapshotId: string };

    const createdEntry = entries.find((e) => e.event === LedgerEvent.SandboxCreated);
    const createdPayload = createdEntry?.payload as
      | {
          resources?: { cpu?: string; memory?: string; gpu?: string };
          runId?: string;
          resourceId?: string;
          teamId?: string;
          networkPolicy?: NetworkPolicy;
          credentialProxy?: boolean;
        }
      | undefined;
    const resources = createdPayload?.resources;
    // Inherit the original sandbox's runId — a resumed sandbox is a continuation of the
    // same run, not a new one. Falls back to a fresh UUID only for ledger data written
    // before this field existed.
    const runId = createdPayload?.runId ?? crypto.randomUUID();
    // Same inheritance as runId — a resumed sandbox keeps scoping to the same memory
    // resource as its origin. Unlike runId, no fallback: absence just means "not scoped."
    const resourceId = createdPayload?.resourceId;
    const teamId = createdPayload?.teamId;
    // Same reasoning applies to network policy / credential proxy — a resumed sandbox gets
    // the same egress posture as its origin, recovered from ledger data since the OpenSandbox
    // control plane doesn't echo `networkPolicy` back on GET /v1/sandboxes.
    const networkPolicy = createdPayload?.networkPolicy;
    const credentialProxy = createdPayload?.credentialProxy;

    // Latest bound/revoked state per credential name, scanned across the whole session
    // history (not just the pre-checkpoint slice below, which is exec-replay-specific) —
    // the vault itself doesn't survive the resume, so this is how we know what to re-`set()`.
    const boundCredentials = reconstructBoundCredentials(entries);
    // Same story for runtime egress-policy changes (`sb.egress.patch()`): sidecar-local, not
    // restored by the snapshot, so re-apply whatever is still live per the ledger.
    const egressRulesToReplay = networkPolicy ? reconstructEgressRules(entries) : [];

    const replayCache = new Map<number, ExecResult>();
    const pendingStdout = new Map<number, string[]>();
    const pendingStderr = new Map<number, string[]>();
    const pendingStdin = new Map<number, string[]>();
    const interactiveMeta = new Map<
      number,
      { cmd: string; cwd?: string; env?: Record<string, string> }
    >();

    for (const entry of entries.slice(0, checkpointIdx)) {
      if (entry.event === LedgerEvent.ExecStart) {
        const { seq, cmd, interactive, cwd, env } = entry.payload as {
          seq: number;
          cmd: string;
          interactive?: boolean;
          cwd?: string;
          env?: Record<string, string>;
        };
        pendingStdout.set(seq, []);
        pendingStderr.set(seq, []);
        if (interactive) {
          pendingStdin.set(seq, []);
          interactiveMeta.set(seq, { cmd, cwd, env });
        }
      } else if (entry.event === LedgerEvent.ExecEvent) {
        const { seq, type, text } = entry.payload as { seq: number; type: string; text?: string };
        if (text) {
          if (type === "stdout") pendingStdout.get(seq)?.push(text);
          else if (type === "stderr") pendingStderr.get(seq)?.push(text);
          else if (type === "stdin") pendingStdin.get(seq)?.push(text);
        }
      } else if (entry.event === LedgerEvent.ExecComplete) {
        const { seq, exitCode } = entry.payload as { seq: number; exitCode: number };
        replayCache.set(seq, {
          stdout: (pendingStdout.get(seq) ?? []).join(""),
          stderr: (pendingStderr.get(seq) ?? []).join(""),
          exitCode,
        });
      }
    }

    // Interactive sessions with an ExecStart but no ExecComplete before the checkpoint were
    // still open (a human mid-conversation) — reconstruct them by replaying stdin, not by
    // dropping them like a finished/never-started plain exec would be.
    const pendingInteractive = new Map<number, PendingInteractiveExec>();
    for (const [seq, meta] of interactiveMeta) {
      if (replayCache.has(seq)) continue;
      pendingInteractive.set(seq, {
        ...meta,
        stdin: pendingStdin.get(seq) ?? [],
        stdout: (pendingStdout.get(seq) ?? []).join(""),
      });
    }

    await this._acquireSlot();
    try {
      const rawSb = await this._control.createSandbox({
        snapshotId,
        resourceLimits: resources,
        metadata: { runId },
        networkPolicy,
        credentialProxy: credentialProxy ? { enabled: true } : undefined,
      });
      const newSessionId = rawSb.id;
      await this._waitForRunning(newSessionId);

      await this._adapter.append({
        ts: Date.now(),
        name,
        sandboxId: newSessionId,
        stepIndex: -1,
        event: LedgerEvent.SandboxCreated,
        payload: {
          sandboxId: newSessionId,
          resumedFrom: sandboxId,
          snapshotId,
          runId,
          resourceId,
          teamId,
          networkPolicy,
          credentialProxy,
        },
      });

      const sb = new SandboxHandle(
        newSessionId,
        name,
        {
          control: this._control,
          adapter: this._adapter,
          credentialBroker: this._credentialBroker,
          onClose: () => {
            this._releaseSlot();
          },
          fork:
            resources?.cpu && resources.memory
              ? (snapshotId, tag, overrideRunId, forkOpts) =>
                  this._forkFromSnapshot(
                    snapshotId,
                    name,
                    resources as { cpu: string; memory: string; gpu?: string },
                    undefined,
                    overrideRunId ?? runId,
                    newSessionId,
                    resourceId,
                    teamId,
                    forkOpts,
                  )
              : undefined,
          useServerProxy: this._useServerProxy,
        },
        replayCache,
        pendingInteractive,
      );

      // Vault state is sidecar-runtime-only — re-register whatever was bound on the original
      // sandbox. "env"-sourced credentials resolve automatically; anything else needs
      // `resolveCredential` or resume() throws rather than silently dropping it. No-op (empty
      // map, loop doesn't run) if the original session never bound any.
      for (const [credName, { binding, source }] of boundCredentials) {
        const value = await resolveBoundCredential(
          credName,
          source,
          resolveCredential,
          newSessionId,
        );
        await sb.credentials.set(credName, value, binding, source);
      }

      // Re-apply runtime egress-policy changes. Safe when non-empty: `egressRulesToReplay`
      // is only populated when the resumed sandbox has a `networkPolicy` (hence a sidecar).
      if (egressRulesToReplay.length > 0) {
        await sb.egress.patch(egressRulesToReplay);
      }

      return sb;
    } catch (err) {
      this._releaseSlot();
      throw err;
    }
  }

  /**
   * Attach to an already-running sandbox container without creating or restoring anything.
   *
   * Use this to reconnect to a sandbox whose host process has exited but whose container
   * is still running. Unlike `resume()`, no snapshot is involved — the container keeps
   * its current state. The execd endpoint is resolved lazily on first use.
   *
   * @throws `SandboxClientError` (409) if the sandbox is not in Running state.
   *
   * @param opts.resources  CPU/memory/GPU to use if `.fork()` is later called on the
   *   returned `SandboxHandle`. The control API doesn't echo back a running sandbox's own
   *   resource limits, so there's no way to discover them automatically here — omit
   *   this and `.fork()` will throw. Pass it (e.g. from `alineo.config.json`'s
   *   defaults) when the caller needs fork support on a merely-connected sandbox.
   * @param opts.runId  Default run-correlation ID for any later `.fork()` call on the
   *   returned `SandboxHandle`. `connect()` has no way to discover the sandbox's original
   *   `runId` (no ledger lookup is attempted — the caller may be using a completely
   *   different adapter than whatever originally created it, as `alineo fork` does when
   *   self-attaching). Omit this and pass `runId` explicitly to `.fork()` itself instead.
   *
   * @example
   * ```ts
   * // In a new process, reconnect to a sandbox started earlier:
   * const sb = await client.connect(savedSandboxId, "my-sandbox");
   * const { stdout } = await sb.exec("cat /results.txt");
   * await sb.close();
   * ```
   */
  async connect(
    sandboxId: string,
    name: string,
    opts?: {
      resources?: { cpu: string; memory: string; gpu?: string };
      runId?: string;
      /** Default resource scope for any later `.fork()` call — see `SandboxOptions.resourceId`.
       *  Same rationale as `opts.runId`: `connect()` does no ledger lookup, so it can't
       *  discover the sandbox's original `resourceId` on its own. */
      resourceId?: string;
      /** Default team scope for any later `.fork()` call — see `SandboxOptions.teamId`. Same
       *  rationale as `opts.resourceId`. */
      teamId?: string;
    },
  ): Promise<SandboxHandle> {
    await this._ensureConnected();
    const info = await this._control.getSandbox(sandboxId);
    if (info.status.state !== SandboxState.Running) {
      throw new SandboxClientError(
        `SandboxHandle ${sandboxId} is ${info.status.state} — can only connect to Running sandboxes`,
        409,
      );
    }
    await this._acquireSlot();
    const resources = opts?.resources;
    return new SandboxHandle(sandboxId, name, {
      control: this._control,
      adapter: this._adapter,
      credentialBroker: this._credentialBroker,
      onClose: () => {
        this._releaseSlot();
      },
      fork: resources
        ? (snapshotId, tag, overrideRunId, forkOpts) =>
            this._forkFromSnapshot(
              snapshotId,
              name,
              resources,
              undefined,
              overrideRunId ?? opts?.runId,
              sandboxId,
              opts?.resourceId,
              opts?.teamId,
              forkOpts,
            )
        : undefined,
      useServerProxy: this._useServerProxy,
    });
  }

  /**
   * Create a fresh sandbox from a snapshot ID without exec replay.
   *
   * Unlike `resume()`, this does not replay prior exec results — the new sandbox
   * starts with a clean exec history. Use this when you want to restore a
   * checkpointed environment and run new commands from scratch.
   *
   * @param snapshotId  The snapshot ID returned by `sb.checkpoint()`.
   * @param name        A name for the new sandbox session in the ledger.
   * @param resources   CPU and memory for the restored container.
   * @param runId       Run-correlation ID for the restored sandbox — see `SandboxDetails.runId`.
   *   Defaults to a fresh `crypto.randomUUID()` if omitted.
   *
   * @example
   * ```ts
   * const snapshotId = await sb.checkpoint();
   * await sb.close();
   *
   * // Later — restore and run fresh commands:
   * const sb2 = await client.restoreSnapshot(snapshotId, "my-sandbox", { cpu: "500m", memory: "256Mi" });
   * await sb2.exec("npm test");
   * await sb2.close();
   * ```
   */
  async restoreSnapshot(
    snapshotId: string,
    name: string,
    resources: { cpu: string; memory: string; gpu?: string },
    runId?: string,
    opts?: {
      networkPolicy?: NetworkPolicy;
      credentialProxy?: boolean;
      /**
       * Environment for the restored sandbox — normally omitted (a snapshot already carries
       * its container env). Use it only for `OPENSANDBOX_EGRESS_*` sidecar vars, which are
       * process-scoped and must be re-supplied on every restore (the sidecar is not
       * snapshotted): the server routes those to the sidecar and drops them from the
       * container.
       */
      env?: Record<string, string>;
      /** Resource scope for the restored sandbox — see `SandboxOptions.resourceId`. Unlike
       *  `resume()`, `restoreSnapshot()` has no prior ledger session of its own to inherit
       *  from (the snapshot may have come from anywhere), so this must be passed explicitly. */
      resourceId?: string;
      /** Team scope for the restored sandbox — see `SandboxOptions.teamId`. Same rationale as
       *  `resourceId` above. */
      teamId?: string;
    },
  ): Promise<SandboxHandle> {
    assertValidNetworkPolicy(opts?.networkPolicy);
    await this._ensureConnected();
    await this._acquireSlot();
    try {
      const finalRunId = runId ?? crypto.randomUUID();
      const rawSb = await this._control.createSandbox({
        snapshotId,
        env: opts?.env,
        resourceLimits: resources,
        metadata: { runId: finalRunId },
        networkPolicy: opts?.networkPolicy,
        credentialProxy: opts?.credentialProxy ? { enabled: true } : undefined,
      });
      const newId = rawSb.id;
      await this._waitForRunning(newId);
      await this._adapter.append({
        ts: Date.now(),
        name,
        sandboxId: newId,
        stepIndex: -1,
        event: LedgerEvent.SandboxCreated,
        payload: {
          sandboxId: newId,
          fromSnapshot: snapshotId,
          runId: finalRunId,
          resourceId: opts?.resourceId,
          teamId: opts?.teamId,
          networkPolicy: opts?.networkPolicy,
          credentialProxy: opts?.credentialProxy,
        },
      });
      return new SandboxHandle(newId, name, {
        control: this._control,
        adapter: this._adapter,
        credentialBroker: this._credentialBroker,
        onClose: () => {
          this._releaseSlot();
        },
        fork: (snapshotId, tag, overrideRunId, forkOpts) =>
          this._forkFromSnapshot(
            snapshotId,
            name,
            resources,
            undefined,
            overrideRunId ?? finalRunId,
            newId,
            opts?.resourceId,
            opts?.teamId,
            forkOpts,
          ),
        useServerProxy: this._useServerProxy,
      });
    } catch (err) {
      this._releaseSlot();
      throw err;
    }
  }

  /**
   * SandboxHandle history management. List, inspect, and delete past sandbox records.
   *
   * @example
   * ```ts
   * const all = await client.sandboxes.list();
   * const details = await client.sandboxes.get("ci", sandboxId);
   * await client.sandboxes.delete("ci", sandboxId);
   * ```
   */
  readonly sandboxes = {
    /** List all sandbox records across all names, newest first. */
    list: async (opts?: ListSandboxOptions): Promise<SandboxDetails[]> => {
      await this._ensureConnected();
      return this._adapter.listAllSandboxDetails(opts);
    },

    /** List sandbox records for a specific name, newest first. */
    listByName: async (name: string, opts?: ListSandboxOptions): Promise<SandboxDetails[]> => {
      await this._ensureConnected();
      return this._adapter.listSandboxDetails(name, opts);
    },

    /** Return details for a single sandbox record. Returns `null` if not found. */
    get: async (name: string, sandboxId: string): Promise<SandboxDetails | null> => {
      await this._ensureConnected();
      return this._adapter.getSandboxDetails(name, sandboxId);
    },

    /** Delete all ledger events for a sandbox. */
    delete: async (name: string, sandboxId: string): Promise<void> => {
      await this._ensureConnected();
      return this._adapter.deleteSandbox(name, sandboxId);
    },
  };

  /**
   * Define a named, reusable sandbox environment.
   *
   * Returns an `Environment` object — no I/O happens here. The first call to
   * `env.sandbox()` builds the environment (runs setup + snapshots), then caches
   * the snapshot ID in the ledger. Subsequent calls restore from that snapshot.
   *
   * @example
   * ```ts
   * const env = client.environment("python", {
   *   image: "debian:bookworm-slim",
   *   resources: { cpu: "500m", memory: "512Mi" },
   *   setup: async (sb) => {
   *     await sb.exec("apt-get update -qq && apt-get install -y python3-pip");
   *     await sb.exec("pip install numpy pandas");
   *   },
   * });
   *
   * const sb = await env.sandbox();
   * try {
   *   await sb.exec("python3 -c 'import pandas; print(pandas.__version__)'").pipe(process.stdout);
   * } finally {
   *   await sb.close();
   * }
   * ```
   */
  environment(name: string, opts: EnvironmentOptions): Environment {
    return new Environment(name, opts, this);
  }

  /**
   * Environment management. List and delete cached environment records.
   *
   * @example
   * ```ts
   * const envs = await client.environments.list();
   * await client.environments.delete("python");
   * ```
   */
  readonly environments = {
    /** Return all environment records, newest first. */
    list: async (): Promise<EnvironmentRecord[]> => {
      await this._ensureConnected();
      return this._adapter.listEnvironments();
    },
    /** Remove the ledger record for a named environment. Does not delete the server-side snapshot. */
    delete: async (name: string): Promise<void> => {
      await this._ensureConnected();
      return this._adapter.deleteEnvironment(name);
    },
  };

  // ── Internal ──────────────────────────────────────────────────────────────

  // ── Environment internals (called by Environment class) ──────────────────

  async _envInfo(name: string): Promise<EnvironmentRecord | null> {
    await this._ensureConnected();
    return this._adapter.getEnvironment(name);
  }

  async _envRebuild(name: string, opts: EnvironmentOptions): Promise<void> {
    await this._ensureConnected();
    await this._buildEnvironment(name, opts);
  }

  async _envSandbox(
    name: string,
    opts: EnvironmentOptions,
    extra?: EnvironmentSandboxOptions,
  ): Promise<SandboxHandle> {
    await this._ensureConnected();

    const record = await this._adapter.getEnvironment(name);
    if (record) {
      const snap = await this._control.getSnapshot(record.snapshotId).catch(() => null);
      if (snap?.state === SnapshotState.Ready) {
        return this._createFromSnapshot(record.snapshotId, opts.resources, name, opts.shell, extra);
      }
      // Stale snapshot (server-side TTL or deletion) — fall through to rebuild
    }

    const snapshotId = await this._getOrBuildEnvironment(name, opts);
    return this._createFromSnapshot(snapshotId, opts.resources, name, opts.shell, extra);
  }

  _getOrBuildEnvironment(name: string, opts: EnvironmentOptions): Promise<string> {
    const inflight = this._envBuilds.get(name);
    if (inflight) return inflight;
    const build = this._buildEnvironment(name, opts).finally(() => this._envBuilds.delete(name));
    this._envBuilds.set(name, build);
    return build;
  }

  async _buildEnvironment(name: string, opts: EnvironmentOptions): Promise<string> {
    const image = typeof opts.image === "string" ? opts.image : opts.image.uri;
    const buildName = `env-${name}-build`;

    const sb = await this.sandbox({
      image: opts.image,
      resources: opts.resources,
      name: buildName,
      shell: opts.shell,
    });
    try {
      await opts.setup(sb);
      await sb.checkpoint(`env:${name}`);
    } finally {
      await sb.close();
    }

    const checkpoint = await this._adapter.lastCheckpoint(buildName, sb.sandboxId);
    if (!checkpoint)
      throw new SandboxClientError(`Environment build for '${name}' produced no checkpoint`, 500);
    const { snapshotId } = checkpoint.payload as { snapshotId: string };

    await this._adapter.saveEnvironment({ name, snapshotId, image, builtAt: Date.now() });
    return snapshotId;
  }

  async _createFromSnapshot(
    snapshotId: string,
    resources: { cpu: string; memory: string; gpu?: string },
    envName: string,
    envShell?: string,
    extra?: EnvironmentSandboxOptions,
  ): Promise<SandboxHandle> {
    await this._acquireSlot();
    try {
      const runId = crypto.randomUUID();
      const rawSb = await this._control.createSandbox({
        snapshotId,
        resourceLimits: resources,
        env: extra?.env,
        metadata: { runId },
      });
      const newId = rawSb.id;
      await this._waitForRunning(newId);

      const sessionName = `env-${envName}-${newId.slice(0, 8)}`;
      // Unlike sandbox()/resume()/restoreSnapshot(), a sandbox spawned from an environment has
      // no prior ledger session to inherit resourceId/teamId from — read from `extra` (see
      // `EnvironmentSandboxOptions`) the same way `restoreSnapshot()` reads from its own opts.
      const resourceId = extra?.resourceId;
      const teamId = extra?.teamId;
      await this._adapter.append({
        ts: Date.now(),
        name: sessionName,
        sandboxId: newId,
        stepIndex: -1,
        event: LedgerEvent.SandboxCreated,
        payload: {
          sandboxId: newId,
          fromEnvironment: envName,
          snapshotId,
          runId,
          resourceId,
          teamId,
        },
      });

      const sb = new SandboxHandle(newId, sessionName, {
        control: this._control,
        adapter: this._adapter,
        credentialBroker: this._credentialBroker,
        hooks: extra?.hooks,
        onClose: () => {
          this._releaseSlot();
        },
        shell: extra?.shell ?? envShell,
        fork: (snapshotId, tag, overrideRunId, forkOpts) =>
          this._forkFromSnapshot(
            snapshotId,
            sessionName,
            resources,
            extra?.shell ?? envShell,
            overrideRunId ?? runId,
            newId,
            resourceId,
            teamId,
            forkOpts,
          ),
        useServerProxy: this._useServerProxy,
      });
      extra?.hooks?.onSandboxCreated?.(newId, sessionName);
      return sb;
    } catch (err) {
      this._releaseSlot();
      throw err;
    }
  }

  private async _forkFromSnapshot(
    snapshotId: string,
    parentName: string,
    resources: { cpu: string; memory: string; gpu?: string },
    shell?: string,
    runId?: string,
    parentSandboxId?: string,
    resourceId?: string,
    teamId?: string,
    forkOpts?: {
      networkPolicy?: NetworkPolicy;
      credentialProxy?: boolean;
      resourceId?: string;
      teamId?: string;
    },
  ): Promise<SandboxHandle> {
    await this._acquireSlot();
    try {
      // Resolved once here, not left to the control-plane call, the ledger write, and
      // the child's own fork closure to each fall back independently — they'd otherwise
      // generate different UUIDs for what should be a single sandbox's one identity.
      const finalRunId = runId ?? crypto.randomUUID();
      // `forkOpts.resourceId`/`forkOpts.teamId`, when given, override the values this
      // closure would otherwise inherit from whatever sandbox `.fork()` was called on — see
      // `SandboxDeps.fork`'s own doc comment. Resolved once here for the same reason
      // `finalRunId` is: so the ledger write below and the child's own recursive fork
      // closure agree on one value, not two independently-defaulted ones.
      const finalResourceId = forkOpts?.resourceId ?? resourceId;
      const finalTeamId = forkOpts?.teamId ?? teamId;
      const rawSb = await this._control.createSandbox({
        snapshotId,
        resourceLimits: resources,
        metadata: { runId: finalRunId },
        networkPolicy: forkOpts?.networkPolicy,
        credentialProxy: forkOpts?.credentialProxy ? { enabled: true } : undefined,
      });
      const newId = rawSb.id;
      await this._waitForRunning(newId);

      const sessionName = `fork-${parentName}-${newId.slice(0, 8)}`;
      await this._adapter.append({
        ts: Date.now(),
        name: sessionName,
        sandboxId: newId,
        stepIndex: -1,
        event: LedgerEvent.SandboxCreated,
        payload: {
          sandboxId: newId,
          forkedFrom: snapshotId,
          runId: finalRunId,
          // Inherited from the parent by default — a fork is normally a continuation of the
          // same resource's (and team's) memory, not a new resource — but overridable per-call
          // via forkOpts (see finalResourceId/finalTeamId above), for a fork that's a
          // *different* resource (e.g. Alineo.spawn()). parentSandboxId, unlike
          // resourceId/teamId, is never inherited further down: it always names the
          // *immediate* parent, so a lineage can be walked one hop at a time (see
          // episodicRecall's lineage option).
          resourceId: finalResourceId,
          teamId: finalTeamId,
          parentSandboxId,
          networkPolicy: forkOpts?.networkPolicy,
          credentialProxy: forkOpts?.credentialProxy,
        },
      });

      return new SandboxHandle(newId, sessionName, {
        control: this._control,
        adapter: this._adapter,
        credentialBroker: this._credentialBroker,
        onClose: () => {
          this._releaseSlot();
        },
        shell,
        fork: (sid, tag, overrideRunId, nextForkOpts) =>
          this._forkFromSnapshot(
            sid,
            sessionName,
            resources,
            shell,
            overrideRunId ?? finalRunId,
            newId,
            finalResourceId,
            finalTeamId,
            nextForkOpts,
          ),
        useServerProxy: this._useServerProxy,
      });
    } catch (err) {
      this._releaseSlot();
      throw err;
    }
  }

  private async _waitForRunning(sandboxId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Starts fast and backs off to 1s — most containers are Running well under
    // one fixed-interval tick, so a flat 1s poll was pure waste in the common case.
    let delay = 100;
    while (Date.now() < deadline) {
      const s = await this._control.getSandbox(sandboxId);
      if (s.status.state === SandboxState.Running) return;
      if (s.status.state === SandboxState.Failed || s.status.state === SandboxState.Terminated) {
        throw new SandboxClientError(
          `SandboxHandle ${sandboxId} entered state ${s.status.state}: ${s.status.message ?? ""}`,
          500,
        );
      }
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 1_000);
    }
    throw new SandboxClientError(
      `SandboxHandle ${sandboxId} did not reach Running within ${timeoutMs}ms`,
      408,
    );
  }

  private async _acquireSlot(): Promise<void> {
    if (!this._maxConcurrency || this._activeCount < this._maxConcurrency) {
      this._activeCount++;
      return;
    }
    await new Promise<void>((resolve) => this._waiters.push(resolve));
    this._activeCount++;
  }

  private _releaseSlot(): void {
    this._activeCount--;
    this._waiters.shift()?.();
  }
}
