/** Test doubles for the SDK and the model, installed by `setup.ts`. */

// ── @alineo-labs/sandbox fake (the raw-sandbox subsystem, sandboxes/engine.ts) ──────────
//
// Stands in for
// `@alineo-labs/sandbox`'s `Sandbox`/`SandboxHandle`, which the sandboxes/workflows routes use
// directly. The real `SandboxHandle` writes every lifecycle event to the SDK ledger adapter
// itself (`packages/core/src/sandbox/core.ts`'s `emit()`); this fake does the same — by hand,
// straight through `ledger.append()` — so `GET /sandboxes` (which reads the ledger, not
// this fake's own state) sees what a real sandbox would have left behind.
import { ledger } from "../ledger";

let fakeSandboxCounter = 0;

export class FakeSandboxHandle {
  readonly sandboxId: string;
  readonly name: string;
  readonly runId: string;
  closed = false;
  checkpoints: { snapshotId: string; tag?: string; createdAt: number }[] = [];
  credentialBindings = new Map<string, unknown>();
  egressRules: Array<{ action: "allow" | "deny"; target: string }> = [];
  execCalls: string[] = [];
  private readonly hooks?: {
    onSandboxCreated?: (sandboxId: string, name: string) => void;
    onExecStart?: (sandboxId: string, seq: number, cmd: string) => void;
    onExecComplete?: (sandboxId: string, seq: number, result: unknown) => void;
  };
  private execSeq = 0;

  constructor(opts: {
    name?: string;
    runId?: string;
    parentSandboxId?: string;
    hooks?: FakeSandboxHandle["hooks"];
  }) {
    this.sandboxId = `fsb-${++fakeSandboxCounter}`;
    this.name = opts.name ?? `sandbox-${this.sandboxId}`;
    this.runId = opts.runId ?? crypto.randomUUID();
    this.hooks = opts.hooks;
    this.hooks?.onSandboxCreated?.(this.sandboxId, this.name);
    void ledger.append({
      ts: Date.now(),
      name: this.name,
      sandboxId: this.sandboxId,
      stepIndex: -1,
      event: "sandbox.created" as never,
      payload: { runId: this.runId, parentSandboxId: opts.parentSandboxId },
    });
  }

  async checkpoint(tag?: string): Promise<string> {
    const snapshotId = `snap-${this.sandboxId}-${this.checkpoints.length + 1}`;
    this.checkpoints.push({ snapshotId, tag, createdAt: Date.now() });
    void ledger.append({
      ts: Date.now(),
      name: this.name,
      sandboxId: this.sandboxId,
      stepIndex: -1,
      event: "sandbox.checkpoint_created" as never,
      payload: { snapshotId, name: tag },
    });
    return snapshotId;
  }

  async listCheckpoints() {
    return this.checkpoints;
  }

  async fork(tag?: string): Promise<FakeSandboxHandle> {
    const child = new FakeSandboxHandle({
      runId: this.runId,
      parentSandboxId: this.sandboxId,
    });
    fakeSandboxClient.live.set(child.sandboxId, child);
    void tag;
    return child;
  }

  async close(): Promise<void> {
    this.closed = true;
    void ledger.append({
      ts: Date.now(),
      name: this.name,
      sandboxId: this.sandboxId,
      stepIndex: -1,
      event: "sandbox.closed" as never,
      payload: {},
    });
  }

  readonly credentials = {
    set: async (name: string, _value: string, binding: unknown): Promise<void> => {
      this.credentialBindings.set(name, binding);
    },
    remove: async (name: string): Promise<void> => {
      this.credentialBindings.delete(name);
    },
    listBindings: async () =>
      [...this.credentialBindings.entries()].map(([name, binding]) => ({ name, binding })),
  };

  readonly egress = {
    get: async () => ({ status: "ok", policy: { egress: this.egressRules } }),
    patch: async (rules: Array<{ action: "allow" | "deny"; target: string }>): Promise<void> => {
      for (const rule of rules) {
        const i = this.egressRules.findIndex((r) => r.target === rule.target);
        if (i === -1) this.egressRules.push(rule);
        else this.egressRules[i] = rule;
      }
    },
    delete: async (targets: string[]): Promise<void> => {
      this.egressRules = this.egressRules.filter((r) => !targets.includes(r.target));
    },
  };

  exec(cmd: string, opts?: { interactive?: boolean }): unknown {
    this.execCalls.push(cmd);
    if (opts?.interactive) {
      return {
        async *stdout() {
          yield `$ ${cmd}\n`;
        },
        write: () => {},
        resize: () => {},
        signal: () => {},
        close: async () => {},
      };
    }
    const seq = ++this.execSeq;
    this.hooks?.onExecStart?.(this.sandboxId, seq, cmd);
    const result = { stdout: `ran ${cmd}`, stderr: "", exitCode: 0 };
    this.hooks?.onExecComplete?.(this.sandboxId, seq, result);
    return {
      async *stdout() {
        yield result.stdout;
      },
      result: async () => result,
      then: (resolve: (r: typeof result) => void) => resolve(result),
    };
  }

  watchMetrics(): AsyncGenerator<{ cpu: number; memory: number }> {
    let n = 0;
    return (async function* () {
      while (n < 2) {
        yield { cpu: 0.1 * ++n, memory: 128 };
        await Bun.sleep(5);
      }
    })();
  }
}

export const fakeSandboxClient = {
  live: new Map<string, FakeSandboxHandle>(),
  createError: undefined as Error | undefined,
  reset(): void {
    this.live.clear();
    this.createError = undefined;
  },
};

export class FakeSandboxClientClass {
  constructor(_opts: unknown) {}

  async sandbox(opts: {
    name?: string;
    resources?: unknown;
    hooks?: FakeSandboxHandle["hooks"];
  }): Promise<FakeSandboxHandle> {
    if (fakeSandboxClient.createError) throw fakeSandboxClient.createError;
    if (!opts.resources) throw new Error("resources is required");
    const sb = new FakeSandboxHandle({ name: opts.name, hooks: opts.hooks });
    fakeSandboxClient.live.set(sb.sandboxId, sb);
    return sb;
  }

  async connect(sandboxId: string, _name: string, _opts?: unknown): Promise<FakeSandboxHandle> {
    const sb = fakeSandboxClient.live.get(sandboxId);
    if (!sb) throw new Error(`sandbox ${sandboxId} not found`);
    return sb;
  }

  async resume(sandboxId: string): Promise<FakeSandboxHandle> {
    const sb = fakeSandboxClient.live.get(sandboxId);
    if (!sb) throw new Error(`sandbox ${sandboxId} not found`);
    return sb;
  }
}

// ── `ai`'s generateObject, for the NL swarm planner (swarms/planner.ts) ────────────────
//
// Keeps `/swarms/plan` tests off the real network/model: the planner's own validation logic
// (validatePlan) is what's worth exercising, not Gemini's actual output for a given prompt.
export const fakeModel = {
  nextPlan: undefined as unknown,
  nextError: undefined as Error | undefined,
  lastPrompt: undefined as string | undefined,
};

export async function fakeGenerateObject(opts: {
  prompt: string;
  schema: { parse: (v: unknown) => unknown };
}): Promise<{ object: unknown }> {
  fakeModel.lastPrompt = opts.prompt;
  if (fakeModel.nextError) throw fakeModel.nextError;
  return { object: opts.schema.parse(fakeModel.nextPlan) };
}
