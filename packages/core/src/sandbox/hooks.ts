import type { SandboxHooks } from "./types";

export interface ComposeHooksOptions {
  /**
   * Called when an individual hook throws. The error is otherwise swallowed — hooks are
   * observability callbacks, so one broken adapter must not break sibling hooks or the
   * sandbox operation that triggered them.
   */
  onHookError?: (error: unknown, hookIndex: number, method: keyof SandboxHooks) => void;
}

/**
 * Merge multiple `SandboxHooks` into one, so more than one hooks-based adapter
 * (`otelHooks(tracer)`, a billing hook, etc.) can attach to the same sandbox without
 * hand-writing a merged object.
 *
 * Hooks fire in the order given, synchronously. Each invocation is isolated in its own
 * try/catch — a throwing hook can't prevent sibling hooks, or the real sandbox operation
 * that triggered them, from completing.
 *
 * @example
 * ```ts
 * import { composeHooks } from "@alineo-labs/core";
 * import { otelHooks } from "@alineo-labs/otel";
 *
 * const sb = await client.sandbox({
 *   image: "ubuntu:22.04",
 *   resources: { cpu: "500m", memory: "512Mi" },
 *   hooks: composeHooks([otelHooks(tracer), billingHooks()], {
 *     onHookError: (error, index, method) => console.error(`hook ${index} ${method} failed`, error),
 *   }),
 * });
 * ```
 */
export function composeHooks(
  hooks: (SandboxHooks | undefined)[],
  opts: ComposeHooksOptions = {},
): SandboxHooks {
  const active = hooks.filter((h): h is SandboxHooks => h != null);

  function call(method: keyof SandboxHooks, index: number, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      opts.onHookError?.(error, index, method);
    }
  }

  return {
    onSandboxCreated(sandboxId, name) {
      active.forEach((h, i) => {
        // .bind(h) preserves the same `this`-bound-to-h semantics a direct
        // `h.onSandboxCreated(...)` call would have, while still giving us a
        // capturable reference the closure below can call after a null check.
        const fn = h.onSandboxCreated?.bind(h);
        if (fn) {
          call("onSandboxCreated", i, () => {
            fn(sandboxId, name);
          });
        }
      });
    },
    onExecStart(sandboxId, seq, cmd) {
      active.forEach((h, i) => {
        const fn = h.onExecStart?.bind(h);
        if (fn) {
          call("onExecStart", i, () => {
            fn(sandboxId, seq, cmd);
          });
        }
      });
    },
    onExecComplete(sandboxId, seq, result) {
      active.forEach((h, i) => {
        const fn = h.onExecComplete?.bind(h);
        if (fn) {
          call("onExecComplete", i, () => {
            fn(sandboxId, seq, result);
          });
        }
      });
    },
    onCheckpoint(sandboxId, snapshotId, name) {
      active.forEach((h, i) => {
        const fn = h.onCheckpoint?.bind(h);
        if (fn) {
          call("onCheckpoint", i, () => {
            fn(sandboxId, snapshotId, name);
          });
        }
      });
    },
    onSandboxClosed(sandboxId) {
      active.forEach((h, i) => {
        const fn = h.onSandboxClosed?.bind(h);
        if (fn) {
          call("onSandboxClosed", i, () => {
            fn(sandboxId);
          });
        }
      });
    },
    onSandboxFailed(sandboxId, error) {
      active.forEach((h, i) => {
        const fn = h.onSandboxFailed?.bind(h);
        if (fn) {
          call("onSandboxFailed", i, () => {
            fn(sandboxId, error);
          });
        }
      });
    },
    onSandboxPaused(sandboxId) {
      active.forEach((h, i) => {
        const fn = h.onSandboxPaused?.bind(h);
        if (fn) {
          call("onSandboxPaused", i, () => {
            fn(sandboxId);
          });
        }
      });
    },
    onSandboxResumed(sandboxId) {
      active.forEach((h, i) => {
        const fn = h.onSandboxResumed?.bind(h);
        if (fn) {
          call("onSandboxResumed", i, () => {
            fn(sandboxId);
          });
        }
      });
    },
    onCredentialInjected(sandboxId, name, binding) {
      active.forEach((h, i) => {
        const fn = h.onCredentialInjected?.bind(h);
        if (fn) {
          call("onCredentialInjected", i, () => {
            fn(sandboxId, name, binding);
          });
        }
      });
    },
  };
}
