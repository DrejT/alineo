import type {
  IStorageAdapter,
  SandboxHooks,
  CredentialBroker,
  CredentialResolver,
} from "@alineo-labs/core";
import { SandboxStatus } from "@alineo-labs/core";
import type { NetworkPolicy } from "@alineo-labs/opensandbox";

export { SandboxStatus };

/**
 * Client-side SDK error carrying an HTTP-style status code, thrown for
 * invariant/state failures such as a sandbox missing from the local ledger
 * (404), a sandbox not in `Running` state (409), or a client-side timeout
 * (408). This does not wrap non-2xx OpenSandbox API responses — those throw
 * `OpenSandboxError` from `@alineo-labs/opensandbox`, which is never rethrown as a
 * `SandboxClientError`.
 */
export class SandboxClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SandboxClientError";
  }
}

/** Options for constructing a {@link Sandbox} client. */
export interface SandboxClientOptions {
  /** Base URL of your OpenSandbox server (e.g. `http://localhost:8080`). */
  baseUrl: string;
  /** OpenSandbox API key. Pass an empty string for local dev with no auth. */
  apiKey?: string;
  /**
   * Storage adapter for persisting sandbox events.
   *
   * Pass `new SQLiteAdapter("./alineo.db")` from `@alineo-labs/sqlite` for local use, or
   * `new PostgresAdapter(connectionString)` from `@alineo-labs/postgres` for production.
   */
  adapter: IStorageAdapter;
  /**
   * Maximum number of sandboxes that may be active simultaneously.
   * When at capacity, `sandbox()` awaits until a slot is free.
   * Omit for no limit.
   */
  maxConcurrency?: number;
  /**
   * Route execd and proxy traffic through the OpenSandbox server instead of
   * connecting to sandbox containers directly. Required when the server runs
   * in Docker (e.g. started via `alineo init`). Defaults to `false`.
   */
  useServerProxy?: boolean;
  /**
   * Broker for `sb.credentials.*` — registers credentials with, and resolves endpoints
   * against, whatever backend actually injects them. Defaults to
   * `OpenSandboxCredentialBroker` (from `@alineo-labs/vault`), wired to this client's own
   * `ControlClient`/`useServerProxy`, if omitted. Only relevant for sandboxes created with
   * `credentialProxy: true`.
   */
  credentialBroker?: CredentialBroker;
}

/** Options for `Sandbox.resume()`. */
export interface ResumeOptions {
  /** Resume from the checkpoint with this tag. Defaults to the most recent checkpoint. */
  tag?: string;
  /**
   * Resolves values for credentials bound via `sb.credentials.set()` on the original sandbox
   * whose `CredentialSource` isn't `"env"` (or whose env var has since become unset) — the
   * vault's own state doesn't survive a resume (it's sidecar-runtime-only), so anything
   * previously bound needs a value from somewhere. `"env"`-sourced credentials resolve
   * automatically without this. Only relevant if the original sandbox had any
   * `sb.credentials.set()` calls; a no-op otherwise. `resume()` throws `SandboxError` if a
   * bound credential can't be resolved (no matching env var, and no callback or one that
   * returns `undefined`) rather than silently omitting it.
   */
  resolveCredential?: CredentialResolver;
}

/** Options for `Sandbox.sandbox()`. */
export interface SandboxOptions {
  /**
   * Container image to run. Pass a string (`"node:22"`) or a full `ImageSpec`
   * with optional auth (`{ uri: "ghcr.io/org/image", auth: { username, password } }`).
   */
  image: string | { uri: string; auth?: { username: string; password: string } };
  /** CPU/memory/GPU resource limits. Required by the OpenSandbox server. */
  resources: { cpu: string; memory: string; gpu?: string };
  /** Environment variables set in the container at startup. */
  env?: Record<string, string>;
  /** Arbitrary key-value labels attached to the sandbox. Not ledger-queryable — see `runId`. */
  metadata?: Record<string, string>;
  /**
   * User-provided name for this sandbox run. Used as the ledger key.
   * Defaults to `"sandbox-<first 8 chars of sandboxId>"` if omitted.
   */
  name?: string;
  /**
   * Identifies the logical run this sandbox belongs to — see `SandboxDetails.runId`.
   * Defaults to a fresh `crypto.randomUUID()` if omitted. A resumed, forked, or
   * restored-from-snapshot sandbox always inherits its origin's `runId` rather than getting
   * a new one, so pass this explicitly only when correlating independent top-level sandboxes
   * that don't share a fork/resume relationship (e.g. two agents started separately by the
   * same host script for one logical run).
   */
  runId?: string;
  /**
   * Durable resource identity this session's memory should be scoped by — see
   * `@alineo-labs/memory`'s `ResourceRef.resourceId`. Unset by default (unlike `runId`, which
   * always gets a generated fallback) — most sandboxes aren't tied to a memory resource.
   * Threaded through the ledger's `sandbox_created` payload the same way `runId` is, and
   * inherited by `resume()`/`fork()`/`restoreSnapshot()` the same way `runId` is.
   */
  resourceId?: string;
  /**
   * Durable team identity this session's memory should be scoped by — see
   * `@alineo-labs/memory`'s `ResourceRef.teamId`. Unset by default, same as `resourceId`.
   * Threaded through the ledger's `sandbox_created` payload the same way `resourceId` is, and
   * inherited by `resume()`/`fork()`/`restoreSnapshot()` the same way.
   */
  teamId?: string;
  /** SandboxHandle lifetime in seconds. Defaults to the OpenSandbox server default. */
  timeout?: number;
  /** Observability hooks (e.g. `otelHooks(tracer)` from `@alineo-labs/otel`). */
  hooks?: SandboxHooks;
  /**
   * Default shell for all `sb.exec()` calls on this sandbox.
   * Pass an absolute path to the shell binary (e.g. `"/bin/bash"`, `"/bin/zsh"`).
   * Defaults to `"/bin/sh"`.
   */
  shell?: string;
  /**
   * Override the container entrypoint. Defaults to `["tail", "-f", "/dev/null"]`
   * which keeps the container alive without a TTY.
   *
   * Set this when using images that need their own init process — for example,
   * `opensandbox/code-interpreter` requires `["/opt/code-interpreter/code-interpreter.sh"]`
   * to start the Jupyter kernel service that `execCode()` depends on.
   */
  entrypoint?: string[];
  /**
   * Outbound network policy, enforced by an egress sidecar attached to this sandbox. Requires
   * the OpenSandbox server to have `egress.image` configured (`alineo init` does this by
   * default). Omit for unrestricted egress and no sidecar at all — the default, unchanged
   * behavior.
   */
  networkPolicy?: NetworkPolicy;
  /**
   * Opts this sandbox into transparent credential injection via `sb.credentials.*`. Requires
   * `networkPolicy` to also be set and the server to be running `egress.mode = "dns+nft"`.
   */
  credentialProxy?: boolean;
}
