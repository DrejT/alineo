import type { SandboxHandle, EnvironmentRecord } from "@alineo-labs/core";
import type { Sandbox } from "./client";
import type { SandboxHooks } from "@alineo-labs/core";

export type { EnvironmentRecord };

export interface EnvironmentOptions {
  /**
   * Container image to boot. Same format as `SandboxOptions.image` —
   * a string URI or a full spec with optional auth.
   */
  image: string | { uri: string; auth?: { username: string; password: string } };
  /** CPU/memory/GPU limits applied to both the build sandbox and each spawned sandbox. */
  resources: { cpu: string; memory: string; gpu?: string };
  /**
   * Setup function run once on a fresh sandbox during the first `env.sandbox()` call
   * (or after `env.rebuild()`). Install packages, copy files, write config — anything
   * that makes the environment ready. The result is snapshotted and reused from then on.
   */
  setup: (sb: SandboxHandle) => Promise<void>;
  /**
   * Default shell for all `exec()` calls — both during setup and in sandboxes spawned
   * from this environment. Pass an absolute path (e.g. `"/bin/bash"`).
   * Defaults to `"/bin/sh"`.
   */
  shell?: string;
}

/** Extra options forwarded to each sandbox spawned from an environment. */
export interface EnvironmentSandboxOptions {
  /** Additional environment variables set at container startup. */
  env?: Record<string, string>;
  /** Observability hooks. */
  hooks?: SandboxHooks;
  /**
   * Override the shell for this spawned sandbox only.
   * Falls back to `EnvironmentOptions.shell`, then `"/bin/sh"`.
   */
  shell?: string;
  /**
   * Resource scope for this spawned sandbox — see `SandboxOptions.resourceId`. Unlike
   * `sandbox()`/`resume()`/`restoreSnapshot()`, a sandbox spawned from an environment has no
   * prior ledger session of its own to inherit from, so this must be passed explicitly here.
   */
  resourceId?: string;
  /** Team scope for this spawned sandbox — see `SandboxOptions.teamId`. Same rationale as
   *  `resourceId` above. */
  teamId?: string;
}

/**
 * A named, reusable sandbox environment.
 *
 * Created via `client.environment(name, opts)`. The first call to `env.sandbox()`
 * runs the setup recipe, snapshots the result, and caches the snapshot ID in the
 * ledger. Subsequent calls restore from that snapshot — skipping setup entirely.
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
export class Environment {
  constructor(
    /** The environment name, as passed to `client.environment()`. */
    readonly name: string,
    private readonly opts: EnvironmentOptions,
    private readonly client: Sandbox,
  ) {}

  /**
   * Return a sandbox pre-configured with this environment.
   *
   * First call: runs the setup recipe (~30–60 s), snapshots the result.
   * Subsequent calls: restores from snapshot (~2–3 s), no setup re-run.
   * Concurrent first calls share a single build — setup runs exactly once.
   */
  sandbox(extra?: EnvironmentSandboxOptions): Promise<SandboxHandle> {
    return this.client._envSandbox(this.name, this.opts, extra);
  }

  /**
   * Force a full rebuild of the environment, regardless of any cached snapshot.
   * Use this after changing the setup recipe.
   */
  rebuild(): Promise<void> {
    return this.client._envRebuild(this.name, this.opts);
  }

  /**
   * Return the cached environment record, or `null` if the environment has not
   * been built yet.
   */
  info(): Promise<EnvironmentRecord | null> {
    return this.client._envInfo(this.name);
  }
}
