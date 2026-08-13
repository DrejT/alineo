import type { IStorageAdapter, SandboxHooks } from "@alineo-labs/core";
import { SandboxStatus } from "@alineo-labs/core";

export { SandboxStatus };

/**
 * Client-side SDK error carrying an HTTP-style status code, thrown for
 * invariant/state failures such as a sandbox missing from the local ledger
 * (404), a sandbox not in `Running` state (409), or a client-side timeout
 * (408). This does not wrap non-2xx OpenSandbox API responses — those throw
 * `OpenSandboxError` from `@alineo-labs/opensandbox`, which is never rethrown as a
 * `AlineoError`.
 */
export class AlineoError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AlineoError";
  }
}

/** Options for constructing a {@link Alineo} client. */
export interface AlineoOptions {
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
}

/** Options for `Alineo.resume()`. */
export interface ResumeOptions {
  /** Resume from the checkpoint with this tag. Defaults to the most recent checkpoint. */
  tag?: string;
}

/** Options for `Alineo.sandbox()`. */
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
  /** Sandbox lifetime in seconds. Defaults to the OpenSandbox server default. */
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
}
