import type { Sandbox } from "@alineo-labs/sandbox";

/**
 * What the suite needs to know about a provider. A provider is "bound" to the suite by one small
 * file that builds one of these. Everything the suite asserts goes through the public SDK
 * (`Sandbox`, `SandboxHandle`), so the same domains keep working when the provider underneath
 * changes.
 */
export interface ProviderBinding {
  /** Shown in test names. */
  name: string;
  /** A fresh client for every domain. Must be connected to a live provider. */
  createClient(): Sandbox;
  /** An image with `sh`, `cat`, and `python3` on it. */
  image: string;
  resources: { cpu: string; memory: string };
  /**
   * What this provider claims to support. A domain whose capability is `false` is skipped, so a
   * provider is never tested for something it does not claim.
   */
  capabilities: {
    /** `checkpoint()` and `fork()`. */
    snapshot: boolean;
    /** `proxy(port)`: an HTTP server inside the sandbox reachable from the host. */
    endpoint: boolean;
  };
  /**
   * Paths a snapshot is known to lose on this provider (for example `/tmp` on gVisor, which
   * mounts it as a separate tmpfs). Listed so the suite documents a known gap instead of failing
   * on it, and so the gap is visible in one place. An entry here that is NOT lost makes the test
   * fail, so the list cannot go stale.
   */
  snapshotKnownLosses?: string[];
  /** Seconds the SSE stream stays silent in the endpoint domain. Default 20. */
  sseIdleSeconds?: number;
}
