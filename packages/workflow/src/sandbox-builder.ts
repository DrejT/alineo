import type {
  SandboxHandle,
  ExecOptions,
  ExecCodeOptions,
  CredentialBinding,
  NetworkRule,
} from "@alineo-labs/sandbox";
import type { WorkflowEvent } from "./events";

/** The `SandboxHandle` methods a flushed op queue calls. */
export type SandboxLike = Pick<
  SandboxHandle,
  | "exec"
  | "execCode"
  | "writeFile"
  | "writeFileBytes"
  | "readFile"
  | "readFileBytes"
  | "deleteFile"
  | "moveFile"
  | "checkpoint"
  | "credentials"
  | "egress"
  | "proxy"
>;

/**
 * A host-side step: receives the live sandbox and the `vars` captured so far. See
 * `SandboxBuilder.host`.
 */
export type HostStep = (
  sandbox: SandboxLike,
  vars: Record<string, unknown>,
) => void | Promise<void>;

/** Where a credential's value comes from; see `SandboxHandle.credentials.set`. */
export type CredentialSource = Parameters<SandboxHandle["credentials"]["set"]>[3];

/**
 * `ExecOptions` plus workflow-only fields. The workflow-only fields are stripped before the
 * command reaches the sandbox.
 */
export interface WorkflowExecOptions extends ExecOptions {
  /** Store this command's own stdout in `vars[as]`. */
  as?: string;
  /**
   * How `as` stores stdout. `"text"` (default) stores it with trailing whitespace trimmed.
   * `"json"` parses it, and the step fails if stdout is not valid JSON.
   */
  parse?: "text" | "json";
  /**
   * Step name reported in `onEvent`. Defaults to the op kind. Events never carry the command
   * text, so a command that contains a secret does not leak through them.
   */
  name?: string;
}

/** An operation queued on a SandboxBuilder and executed later. */
export type SandboxOp =
  | { kind: "exec"; cmd: string; opts: WorkflowExecOptions }
  | { kind: "execCode"; code: string; opts: ExecCodeOptions }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "readFile"; path: string; as: string }
  | { kind: "writeFileBytes"; path: string; bytes: Uint8Array }
  | { kind: "readFileBytes"; path: string; as: string }
  | {
      kind: "setCredential";
      name: string;
      value: string;
      binding: CredentialBinding;
      source?: CredentialSource;
    }
  | { kind: "patchEgress"; rules: NetworkRule[] }
  | { kind: "deleteEgress"; targets: string[] }
  | { kind: "deleteFile"; path: string }
  | { kind: "moveFile"; from: string; to: string }
  | { kind: "checkpoint"; name?: string }
  | { kind: "host"; name: string; fn: HostStep }
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

  /**
   * Queue a shell command.
   *
   * @example
   * ```ts
   * // Store this command's stdout, parsed as JSON, in vars.page
   * sb.exec("agent-browser --json get url", { as: "page", parse: "json", strict: false })
   * ```
   */
  exec(cmd: string, opts: WorkflowExecOptions = {}): this {
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

  /** Queue a binary file write into the sandbox (a session file, a spreadsheet). */
  writeFileBytes(path: string, bytes: Uint8Array): this {
    this._ops.push({ kind: "writeFileBytes", path, bytes });
    return this;
  }

  /**
   * Queue a binary file read from the sandbox, stored in `vars[as]` as a `Uint8Array`. Use
   * this instead of `readFile` for any file that is not UTF-8 text (xlsx, zip, pdf).
   */
  readFileBytes(path: string, as: string): this {
    this._ops.push({ kind: "readFileBytes", path, as });
    return this;
  }

  /**
   * Queue a credential registration (`SandboxHandle.credentials.set`). The sandbox needs
   * `credentialProxy` and a `networkPolicy`. The value stays on the host: the sandbox sends a
   * placeholder or nothing, and the egress proxy injects the real value.
   *
   * @example
   * ```ts
   * sb.setCredential("portal-password", password, {
   *   host: "seller.example.com",
   *   injection: { type: "substitution", placeholder: "PORTAL_PASSWORD", in: ["body"] },
   * })
   * ```
   */
  setCredential(
    name: string,
    value: string,
    binding: CredentialBinding,
    source?: CredentialSource,
  ): this {
    this._ops.push({ kind: "setCredential", name, value, binding, source });
    return this;
  }

  /** Queue an egress rule change (`SandboxHandle.egress.patch`), e.g. to open a download host. */
  patchEgress(rules: NetworkRule[]): this {
    this._ops.push({ kind: "patchEgress", rules });
    return this;
  }

  /** Queue removal of egress rules by target (`SandboxHandle.egress.delete`). */
  deleteEgress(targets: string[]): this {
    this._ops.push({ kind: "deleteEgress", targets });
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
   * Queue a step that runs on the host, not in the sandbox, with the live sandbox handle.
   *
   * The workflow creates and closes its sandboxes itself, so this is the one place a caller
   * can reach the running sandbox: open a port through the proxy, hand a live view to a
   * person, or read state between two queued commands. `fn` runs after every op queued before
   * it and before every op queued after it. A thrown error fails the step like any other.
   *
   * `name` is the step name in `onEvent`. Events never carry what `fn` did or returned.
   *
   * @example
   * ```ts
   * sb.host("live view", async (sandbox) => {
   *   onLive(await enableBrowserStream(sandbox));
   * })
   * ```
   */
  host(name: string, fn: HostStep): this {
    this._ops.push({ kind: "host", name, fn });
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
  /** Named values captured by `readFile`, `readFileBytes` and `exec(..., { as })`. */
  vars: Record<string, unknown>;
  /** Live stdout sink (pipe target). */
  sink?: { write(chunk: string): unknown };
  /** Step event listener (`workflow(client, { onEvent })`). */
  onEvent?: (event: WorkflowEvent) => void;
  /** Shared step counter, so step indexes stay unique across nested and parallel branches. */
  steps?: { next: number };
}

/** Flush a SandboxBuilder's op queue against a live SandboxHandle. */
export async function flushOps(
  sandbox: SandboxLike,
  ops: SandboxOp[],
  ctx: FlushContext,
): Promise<void> {
  for (const op of ops) {
    if (op.kind === "retry" || op.kind === "when" || op.kind === "forEach") {
      await flushControl(sandbox, op, ctx);
    } else {
      await flushStep(sandbox, op, ctx);
    }
  }
}

type ControlOp = Extract<SandboxOp, { kind: "retry" | "when" | "forEach" }>;
type StepOp = Exclude<SandboxOp, ControlOp>;

async function flushControl(sandbox: SandboxLike, op: ControlOp, ctx: FlushContext) {
  switch (op.kind) {
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

/** Run one leaf op and report it through `ctx.onEvent`, if set. */
async function flushStep(sandbox: SandboxLike, op: StepOp, ctx: FlushContext): Promise<void> {
  if (!ctx.onEvent) {
    await runStep(sandbox, op, ctx);
    return;
  }
  const counter = (ctx.steps ??= { next: 0 });
  const index = counter.next++;
  const name =
    op.kind === "exec" && op.opts.name ? op.opts.name : op.kind === "host" ? op.name : op.kind;
  const started = Date.now();
  emit(ctx, { type: "step.started", index, name, kind: op.kind });
  try {
    await runStep(sandbox, op, ctx);
  } catch (err) {
    emit(ctx, {
      type: "step.failed",
      index,
      name,
      kind: op.kind,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  emit(ctx, {
    type: "step.completed",
    index,
    name,
    kind: op.kind,
    durationMs: Date.now() - started,
    ...(op.kind === "exec" || op.kind === "execCode" ? { exitCode: ctx.exitCode } : {}),
  });
}

/** A listener that throws must not fail the step it is observing. */
function emit(ctx: FlushContext, event: WorkflowEvent): void {
  try {
    ctx.onEvent?.(event);
  } catch {
    // Listener errors are the listener's problem.
  }
}

async function runStep(sandbox: SandboxLike, op: StepOp, ctx: FlushContext): Promise<void> {
  switch (op.kind) {
    case "exec": {
      const { as, parse, name: _name, ...execOpts } = op.opts;
      const handle = sandbox.exec(op.cmd, execOpts);
      let own = "";
      if (ctx.sink) {
        for await (const chunk of handle.stdout()) {
          own += chunk;
          ctx.sink.write(chunk);
        }
        const result = await handle.result();
        ctx.exitCode = result.exitCode;
      } else {
        const result = await handle;
        own = result.stdout;
        ctx.exitCode = result.exitCode;
      }
      ctx.stdout += own;
      if (as !== undefined) ctx.vars[as] = parseStdout(own, parse ?? "text", as);
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

    case "writeFileBytes":
      await sandbox.writeFileBytes(op.path, op.bytes);
      break;

    case "readFileBytes":
      ctx.vars[op.as] = await sandbox.readFileBytes(op.path);
      break;

    case "setCredential":
      await sandbox.credentials.set(op.name, op.value, op.binding, op.source);
      break;

    case "patchEgress":
      await sandbox.egress.patch(op.rules);
      break;

    case "deleteEgress":
      await sandbox.egress.delete(op.targets);
      break;

    case "deleteFile":
      await sandbox.deleteFile(op.path);
      break;

    case "moveFile":
      await sandbox.moveFile(op.from, op.to);
      break;

    case "checkpoint":
      await sandbox.checkpoint(op.name);
      break;

    case "host":
      await op.fn(sandbox, ctx.vars);
      break;
  }
}

function parseStdout(stdout: string, parse: "text" | "json", as: string): unknown {
  if (parse === "text") return stdout.trimEnd();
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `exec(..., { as: ${JSON.stringify(as)}, parse: "json" }): stdout is not valid JSON ` +
        `(${stdout.length} bytes)`,
    );
  }
}

async function flushRetry(
  sandbox: SandboxLike,
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
  sandbox: SandboxLike,
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
    // Parallel with concurrency cap. Each worker gets a shallow copy of ctx, so create the
    // step counter first: the copies then share it and step indexes stay unique.
    if (ctx.onEvent) ctx.steps ??= { next: 0 };
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
