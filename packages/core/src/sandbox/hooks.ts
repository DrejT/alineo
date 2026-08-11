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
 * import { composeHooks } from "@drej/core";
 * import { otelHooks } from "@drej/otel";
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
      active.forEach(
        (h, i) =>
          h.onSandboxCreated &&
          call("onSandboxCreated", i, () => h.onSandboxCreated!(sandboxId, name)),
      );
    },
    onExecStart(sandboxId, seq, cmd) {
      active.forEach(
        (h, i) =>
          h.onExecStart && call("onExecStart", i, () => h.onExecStart!(sandboxId, seq, cmd)),
      );
    },
    onExecComplete(sandboxId, seq, result) {
      active.forEach(
        (h, i) =>
          h.onExecComplete &&
          call("onExecComplete", i, () => h.onExecComplete!(sandboxId, seq, result)),
      );
    },
    onCheckpoint(sandboxId, snapshotId, name) {
      active.forEach(
        (h, i) =>
          h.onCheckpoint &&
          call("onCheckpoint", i, () => h.onCheckpoint!(sandboxId, snapshotId, name)),
      );
    },
    onSandboxClosed(sandboxId) {
      active.forEach(
        (h, i) =>
          h.onSandboxClosed && call("onSandboxClosed", i, () => h.onSandboxClosed!(sandboxId)),
      );
    },
    onSandboxFailed(sandboxId, error) {
      active.forEach(
        (h, i) =>
          h.onSandboxFailed &&
          call("onSandboxFailed", i, () => h.onSandboxFailed!(sandboxId, error)),
      );
    },
    onSandboxPaused(sandboxId) {
      active.forEach(
        (h, i) =>
          h.onSandboxPaused && call("onSandboxPaused", i, () => h.onSandboxPaused!(sandboxId)),
      );
    },
    onSandboxResumed(sandboxId) {
      active.forEach(
        (h, i) =>
          h.onSandboxResumed && call("onSandboxResumed", i, () => h.onSandboxResumed!(sandboxId)),
      );
    },
  };
}
