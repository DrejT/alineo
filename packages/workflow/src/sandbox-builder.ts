import type { Sandbox, ExecOptions, ExecCodeOptions, ExecResult } from "alineo";

/** An operation queued on a SandboxBuilder and executed later. */
export type SandboxOp =
  | { kind: "exec"; cmd: string; opts: ExecOptions }
  | { kind: "execCode"; code: string; opts: ExecCodeOptions }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "readFile"; path: string; as: string }
  | { kind: "deleteFile"; path: string }
  | { kind: "moveFile"; from: string; to: string }
  | { kind: "checkpoint"; name?: string }
  | { kind: "retry"; maxAttempts: number; fn: (sb: SandboxBuilder) => void; opts: RetryOptions }
  | {
      kind: "when";
      pred: WhenPredicate;
      then: (sb: SandboxBuilder) => void;
      else?: (sb: SandboxBuilder) => void;
    }
  | {
      kind: "forEach";
      items: unknown[];
      fn: (sb: SandboxBuilder, item: unknown, index: number) => void;
      opts: ForEachOptions;
    };

export interface RetryOptions {
  backoff?: "fixed" | "exponential";
  delayMs?: number;
}

export type WhenPredicate = (ctx: {
  stdout: string;
  exitCode: number;
  vars: Record<string, unknown>;
}) => boolean;

export interface ForEachOptions {
  concurrency?: number;
}

/**
 * Synchronous lazy builder for sandbox operations.
 *
 * All methods queue an operation and return `this` — no awaits, no async.
 * The queue is flushed when `WorkflowBuilder.pipe()` or `.result()` is called.
 * This gives a single `await` at the end regardless of workflow complexity.
 *
 * @example
 * ```ts
 * await workflow(client)
 *   .sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } }, (sb) => {
 *     sb.exec("npm ci")
 *     sb.checkpoint()
 *     sb.retry(3, (sb) => sb.exec("npm test"), { backoff: "exponential" })
 *   })
 *   .pipe(process.stdout);
 * ```
 */
export class SandboxBuilder {
  readonly _ops: SandboxOp[] = [];

  /** Queue a shell command. */
  exec(cmd: string, opts: ExecOptions = {}): this {
    this._ops.push({ kind: "exec", cmd, opts });
    return this;
  }

  /** Queue a code execution (Python/JS/TS via execd code interpreter). */
  execCode(code: string, opts: ExecCodeOptions = {}): this {
    this._ops.push({ kind: "execCode", code, opts });
    return this;
  }

  /** Queue a file write into the sandbox. */
  writeFile(path: string, content: string): this {
    this._ops.push({ kind: "writeFile", path, content });
    return this;
  }

  /** Queue a file read from the sandbox, stored in `vars[as]`. */
  readFile(path: string, as: string): this {
    this._ops.push({ kind: "readFile", path, as });
    return this;
  }

  /** Queue a file deletion inside the sandbox. */
  deleteFile(path: string): this {
    this._ops.push({ kind: "deleteFile", path });
    return this;
  }

  /** Queue a file move/rename inside the sandbox. */
  moveFile(from: string, to: string): this {
    this._ops.push({ kind: "moveFile", from, to });
    return this;
  }

  /** Queue a checkpoint (snapshot). */
  checkpoint(name?: string): this {
    this._ops.push({ kind: "checkpoint", name });
    return this;
  }

  /**
   * Retry an inner builder callback up to `maxAttempts` times on failure.
   *
   * @example
   * ```ts
   * sb.retry(3, (sb) => sb.exec("npm test"), { backoff: "exponential" })
   * ```
   */
  retry(maxAttempts: number, fn: (sb: SandboxBuilder) => void, opts: RetryOptions = {}): this {
    this._ops.push({ kind: "retry", maxAttempts, fn, opts });
    return this;
  }

  /**
   * Conditionally execute one of two builder callbacks based on a predicate.
   *
   * The predicate receives the current `FlushContext`: `stdout` accumulated
   * across every exec run so far in this sandbox, `exitCode` from the most
   * recent exec, and `vars` captured so far.
   *
   * @example
   * ```ts
   * sb.when(
   *   (ctx) => ctx.exitCode === 0,
   *   (sb) => sb.exec("echo success"),
   *   (sb) => sb.exec("echo failure"),
   * )
   * ```
   */
  when(
    pred: WhenPredicate,
    then: (sb: SandboxBuilder) => void,
    otherwise?: (sb: SandboxBuilder) => void,
  ): this {
    this._ops.push({ kind: "when", pred, then, else: otherwise });
    return this;
  }

  /**
   * Execute a builder callback for each item in `items`, optionally in parallel.
   *
   * @example
   * ```ts
   * sb.forEach(["a", "b", "c"], (sb, item) => sb.exec(`echo ${item}`))
   * ```
   */
  forEach(
    items: unknown[],
    fn: (sb: SandboxBuilder, item: unknown, index: number) => void,
    opts: ForEachOptions = {},
  ): this {
    this._ops.push({ kind: "forEach", items, fn, opts });
    return this;
  }
}

/**
 * Execution context threaded through flush operations.
 *
 * Known limitation: inside a `forEach(items, fn, { concurrency: N })` branch
 * with `N > 1`, each parallel worker flushes against a shallow copy of this
 * context (`{ ...ctx }`), so `stdout`/`exitCode` writes from those branches
 * never propagate back — only `vars` (an object reference) does.
 */
export interface FlushContext {
  /** Accumulated stdout across all execs in this sandbox (see limitation above for concurrent forEach). */
  stdout: string;
  /** Exit code of the most recent exec (see limitation above for concurrent forEach). */
  exitCode: number;
  /** Named values captured by `readFile`. */
  vars: Record<string, unknown>;
  /** Live stdout sink (pipe target). */
  sink?: { write(chunk: string): unknown };
}

/** Flush a SandboxBuilder's op queue against a live Sandbox. */
export async function flushOps(
  sandbox: Sandbox,
  ops: SandboxOp[],
  ctx: FlushContext,
): Promise<void> {
  for (const op of ops) {
    switch (op.kind) {
      case "exec": {
        const handle = sandbox.exec(op.cmd, op.opts);
        if (ctx.sink) {
          for await (const chunk of handle.stdout()) {
            ctx.stdout += chunk;
            ctx.sink.write(chunk);
          }
          const result = await handle.result();
          ctx.exitCode = result.exitCode;
        } else {
          const result = await handle;
          ctx.stdout += result.stdout;
          ctx.exitCode = result.exitCode;
        }
        break;
      }

      case "execCode": {
        const handle = sandbox.execCode(op.code, op.opts);
        if (ctx.sink) {
          for await (const chunk of handle.stdout()) {
            ctx.stdout += chunk;
            ctx.sink.write(chunk);
          }
          const result = await handle.result();
          ctx.exitCode = result.exitCode;
        } else {
          const result = await handle;
          ctx.stdout += result.stdout;
          ctx.exitCode = result.exitCode;
        }
        break;
      }

      case "writeFile":
        await sandbox.writeFile(op.path, op.content);
        break;

      case "readFile": {
        const content = await sandbox.readFile(op.path);
        ctx.vars[op.as] = content;
        break;
      }

      case "deleteFile":
        await sandbox.deleteFile(op.path);
        break;

      case "moveFile":
        await sandbox.moveFile(op.from, op.to);
        break;

      case "checkpoint":
        await sandbox.checkpoint(op.name);
        break;

      case "retry":
        await flushRetry(sandbox, op.fn, op.maxAttempts, op.opts, ctx);
        break;

      case "when": {
        const branch = op.pred(ctx) ? op.then : op["else"];
        if (branch) {
          const inner = new SandboxBuilder();
          branch(inner);
          await flushOps(sandbox, inner._ops, ctx);
        }
        break;
      }

      case "forEach":
        await flushForEach(sandbox, op.items, op.fn, op.opts, ctx);
        break;
    }
  }
}

async function flushRetry(
  sandbox: Sandbox,
  fn: (sb: SandboxBuilder) => void,
  maxAttempts: number,
  opts: RetryOptions,
  ctx: FlushContext,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const base = opts.delayMs ?? 1_000;
      const delay = opts.backoff === "exponential" ? base * 2 ** (attempt - 1) : base;
      await new Promise<void>((r) => setTimeout(r, delay));
    }
    try {
      const inner = new SandboxBuilder();
      fn(inner);
      await flushOps(sandbox, inner._ops, ctx);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function flushForEach(
  sandbox: Sandbox,
  items: unknown[],
  fn: (sb: SandboxBuilder, item: unknown, index: number) => void,
  opts: ForEachOptions,
  ctx: FlushContext,
): Promise<void> {
  const concurrency = opts.concurrency ?? 1;
  if (concurrency <= 1) {
    // Sequential
    for (let i = 0; i < items.length; i++) {
      const inner = new SandboxBuilder();
      fn(inner, items[i], i);
      await flushOps(sandbox, inner._ops, ctx);
    }
  } else {
    // Parallel with concurrency cap
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < items.length) {
        const i = idx++;
        const inner = new SandboxBuilder();
        fn(inner, items[i], i);
        await flushOps(sandbox, inner._ops, { ...ctx });
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
  }
}
