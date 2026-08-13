import type { Alineo, SandboxOptions } from "alineo";
import { SandboxBuilder, flushOps, type FlushContext } from "./sandbox-builder";

export interface WorkflowResult {
  /** Concatenated stdout from all sandboxes in the workflow. */
  stdout: string;
  /** Named values captured by `sb.readFile(path, as)`. */
  vars: Record<string, unknown>;
}

/** A single step in a `.sequence()` call. */
export interface SequenceStep {
  image: SandboxOptions["image"];
  resources: SandboxOptions["resources"];
  env?: SandboxOptions["env"];
  timeout?: SandboxOptions["timeout"];
  name?: string;
  run: (sb: SandboxBuilder, prevResult?: WorkflowResult) => void;
}

type WorkflowStage =
  | { type: "sandbox"; opts: SandboxOptions; fn: (sb: SandboxBuilder) => void }
  | { type: "parallel"; configs: SandboxOptions[]; fn: (sb: SandboxBuilder) => void }
  | { type: "sequence"; steps: SequenceStep[] };

/**
 * Lazy workflow builder. Collects stages and executes them all when `.pipe()` or
 * `.result()` is awaited. Sandboxes are created via the `Alineo` client internally
 * — the user never manages sandbox lifecycle when using this layer.
 *
 * @example
 * ```ts
 * import { workflow } from "@alineo-labs/workflow";
 *
 * await workflow(client)
 *   .sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } }, (sb) => {
 *     sb.exec("npm ci")
 *     sb.checkpoint()
 *     sb.retry(3, (sb) => sb.exec("npm test"), { backoff: "exponential" })
 *   })
 *   .pipe(process.stdout);
 * ```
 */
export class WorkflowBuilder {
  private readonly _client: Alineo;
  private readonly _stages: WorkflowStage[] = [];

  constructor(client: Alineo) {
    this._client = client;
  }

  /**
   * Add a sandbox stage. The `fn` callback receives a `SandboxBuilder` to
   * queue operations synchronously. Sandboxes across multiple `.sandbox()` calls
   * run sequentially, top-to-bottom.
   */
  sandbox(opts: SandboxOptions, fn: (sb: SandboxBuilder) => void): this {
    this._stages.push({ type: "sandbox", opts, fn });
    return this;
  }

  /**
   * Run the same operation across multiple sandbox configurations in parallel.
   * All sandboxes receive the same `fn` callback.
   *
   * @example
   * ```ts
   * await workflow(client)
   *   .parallel(
   *     [{ image: "node:20" }, { image: "node:22" }, { image: "node:24" }],
   *     (sb) => sb.exec("npm test"),
   *   )
   *   .pipe(process.stdout);
   * ```
   */
  parallel(configs: SandboxOptions[], fn: (sb: SandboxBuilder) => void): this {
    this._stages.push({ type: "parallel", configs, fn });
    return this;
  }

  /**
   * Run sandboxes in sequence, passing the previous stage's result to the next.
   *
   * @example
   * ```ts
   * await workflow(client)
   *   .sequence([
   *     { image: "node:22", run: (sb) => sb.exec("npm run build") },
   *     { image: "ubuntu:22.04", run: (sb, prev) => sb.exec("./deploy.sh") },
   *   ])
   *   .pipe(process.stdout);
   * ```
   */
  sequence(steps: SequenceStep[]): this {
    this._stages.push({ type: "sequence", steps });
    return this;
  }

  /** Execute the workflow and pipe stdout to a writable. */
  async pipe(writable: { write(chunk: string): unknown }): Promise<void> {
    await this._execute(writable);
  }

  /** Execute the workflow and return the full result. */
  async result(): Promise<WorkflowResult> {
    return this._execute(undefined);
  }

  private async _execute(
    sink: { write(chunk: string): unknown } | undefined,
  ): Promise<WorkflowResult> {
    const combined: WorkflowResult = { stdout: "", vars: {} };

    for (const stage of this._stages) {
      if (stage.type === "sandbox") {
        const result = await this._runSandbox(stage.opts, stage.fn, sink);
        combined.stdout += result.stdout;
        Object.assign(combined.vars, result.vars);
      } else if (stage.type === "parallel") {
        const results = await this._runParallel(stage.configs, stage.fn, sink);
        for (const r of results) {
          combined.stdout += r.stdout;
          Object.assign(combined.vars, r.vars);
        }
      } else if (stage.type === "sequence") {
        const result = await this._runSequence(stage.steps, sink);
        combined.stdout += result.stdout;
        Object.assign(combined.vars, result.vars);
      }
    }

    return combined;
  }

  private async _runSandbox(
    opts: SandboxOptions,
    fn: (sb: SandboxBuilder) => void,
    sink: { write(chunk: string): unknown } | undefined,
  ): Promise<WorkflowResult> {
    const sb = new SandboxBuilder();
    fn(sb);

    const sandbox = await this._client.sandbox(opts);
    try {
      const ctx: FlushContext = { stdout: "", exitCode: 0, vars: {}, sink };
      await flushOps(sandbox, sb._ops, ctx);
      return { stdout: ctx.stdout, vars: ctx.vars };
    } finally {
      await sandbox.close();
    }
  }

  private async _runParallel(
    configs: SandboxOptions[],
    fn: (sb: SandboxBuilder) => void,
    sink: { write(chunk: string): unknown } | undefined,
  ): Promise<WorkflowResult[]> {
    return Promise.all(configs.map((opts) => this._runSandbox(opts, fn, sink)));
  }

  private async _runSequence(
    steps: SequenceStep[],
    sink: { write(chunk: string): unknown } | undefined,
  ): Promise<WorkflowResult> {
    const combined: WorkflowResult = { stdout: "", vars: {} };
    let prev: WorkflowResult | undefined;

    for (const step of steps) {
      const opts: SandboxOptions = {
        image: step.image,
        resources: step.resources,
        env: step.env,
        timeout: step.timeout,
        name: step.name,
      };
      const result = await this._runSandbox(opts, (sb) => step.run(sb, prev), sink);
      combined.stdout += result.stdout;
      Object.assign(combined.vars, result.vars);
      prev = result;
    }

    return combined;
  }
}

/**
 * Create a workflow builder attached to a `Alineo` client.
 *
 * @example
 * ```ts
 * import { workflow } from "@alineo-labs/workflow";
 *
 * await workflow(client)
 *   .sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } }, (sb) => {
 *     sb.exec("npm ci")
 *     sb.exec("npm test")
 *   })
 *   .pipe(process.stdout);
 * ```
 */
export function workflow(client: Alineo): WorkflowBuilder {
  return new WorkflowBuilder(client);
}
