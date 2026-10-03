/**
 * A scriptable stand-in for the `alineo` SDK, installed by setup.ts via `mock.module`.
 *
 * `FakeAgent` mirrors the slice of the `Alineo` instance API alineod calls; `FakeAlineo` mirrors
 * the static constructors (`start` / `reattach` / `resume`). Every agent ever created is kept in
 * `fakeSdk.sandboxes` by sandbox ID, standing in for containers that outlive alineod's process —
 * which is what `reattach`/`resume` look up.
 */
import { readFileSync } from "node:fs";

export interface FakeEvent {
  type: string;
  [key: string]: unknown;
}

export interface FakeTurn {
  /** Stream events yielded before the turn ends. Default: one `text` delta. */
  events?: FakeEvent[];
  /** Held open until this resolves, after the events are yielded. */
  gate?: Promise<void>;
  /** Final assistant text. Default: `reply: <message>`. */
  text?: string | null;
  /** If set, the stream throws this after the gate; `text` (default null) is left as partial output. */
  error?: string;
  /**
   * Pi's message history at the end of the turn. When set, the stream yields a final `agent_end`
   * event carrying it, and `getMessages()` returns it. A last assistant message with
   * `stopReason: "error"` stands in for a model API that refused the request: the stream still
   * ends normally, as it does with the real Pi.
   */
  endMessages?: unknown[];
  /**
   * Stands in for the SDK's inactivity timeout: after the gate, the stream throws
   * `PromptTimeoutError` while Pi keeps working — `streaming` stays true until the test sets
   * `lastText` and flips `streaming` to false.
   */
  detach?: boolean;
}

export interface SpawnOpts {
  spawnDepth?: number;
  maxAgents?: number;
}

let sandboxCounter = 0;

export class FakeAgent {
  readonly sandboxId: string;
  readonly name: string;
  readonly runId: string;

  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  readonly files = new Map<string, string>();
  readonly spawns: Array<{ specPath: string; opts: SpawnOpts; child: FakeAgent }> = [];

  turn: FakeTurn = {};
  lastText: string | null = null;
  /** What `getMessages()` returns. Set by a turn's `endMessages`, or directly by a test. */
  messages: unknown[] = [];
  streaming = false;
  paused = false;
  aborted = false;
  closed = false;

  steerError?: Error;
  pauseError?: Error;
  hangSessionStats = false;
  /** getState() never answers (an unresponsive bridge). A paused agent never answers either. */
  hangState = false;
  /** The bridge's ready probe fails (e.g. the bridge process died while the container was frozen). */
  bridgeDown = false;

  readonly adapter = {
    waitReady: async (_timeoutMs?: number): Promise<void> => {
      if (this.bridgeDown) throw new Error("alineo-bridge did not become ready");
    },
  };

  /** Set to delay every spawn() call on this agent — combine with the `forking` guard below to catch overlap. */
  forkGate?: Promise<void>;
  private forking = false;

  /** Same idea as `forkGate`/`forking`, for `sandbox.pause()`/`.resume()` — catches a concurrent
   *  pause/resume landing on this sandbox while the other is still in flight (agent-lock.ts is
   *  what's supposed to prevent that). */
  pauseGate?: Promise<void>;
  resumeGate?: Promise<void>;
  private pauseOrResumeInFlight = false;
  /** How many times sandbox.pause()/.resume() actually ran — for asserting a cached idempotent
   *  replay didn't re-execute the side effect (as opposed to the command's own no-op guard,
   *  which would also skip re-pausing an already-paused agent with no idempotency involved). */
  pauseCallCount = 0;
  resumeCallCount = 0;

  readonly sandbox = {
    pause: async (): Promise<void> => {
      if (this.pauseOrResumeInFlight) {
        throw new Error(`concurrent pause()/resume() on ${this.sandboxId}`);
      }
      this.pauseOrResumeInFlight = true;
      this.pauseCallCount++;
      try {
        if (this.pauseGate) await this.pauseGate;
        if (this.pauseError) throw this.pauseError;
        this.paused = true;
      } finally {
        this.pauseOrResumeInFlight = false;
      }
    },
    resume: async (): Promise<void> => {
      if (this.pauseOrResumeInFlight) {
        throw new Error(`concurrent pause()/resume() on ${this.sandboxId}`);
      }
      this.pauseOrResumeInFlight = true;
      this.resumeCallCount++;
      try {
        if (this.resumeGate) await this.resumeGate;
        this.paused = false;
      } finally {
        this.pauseOrResumeInFlight = false;
      }
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      this.files.set(path, content);
    },
  };

  constructor(opts: { name: string; runId: string; sandboxId?: string }) {
    this.name = opts.name;
    this.runId = opts.runId;
    this.sandboxId = opts.sandboxId ?? `sb-${++sandboxCounter}`;
    if (fakeSdk.nextTurn) {
      this.turn = fakeSdk.nextTurn;
      fakeSdk.nextTurn = undefined;
    }
    fakeSdk.sandboxes.set(this.sandboxId, this);
  }

  async *prompt(message: string, _opts?: unknown): AsyncGenerator<FakeEvent> {
    this.prompts.push(message);
    const turn = this.turn;
    this.streaming = true;
    let detached = false;
    try {
      for (const ev of turn.events ?? [{ type: "text", text: "…" }]) yield ev;
      if (turn.gate) await turn.gate;
      if (turn.detach) {
        detached = true;
        const err = new Error("Prompt produced no activity for 180s");
        err.name = "PromptTimeoutError";
        throw err;
      }
      if (turn.error) {
        this.lastText = turn.text ?? null;
        throw new Error(turn.error);
      }
      this.lastText = turn.text === undefined ? `reply: ${message}` : turn.text;
      if (turn.endMessages) {
        this.messages = turn.endMessages;
        yield { type: "agent_end", messages: turn.endMessages };
      }
    } finally {
      if (!detached) this.streaming = false;
    }
  }

  async steer(message: string): Promise<void> {
    if (this.steerError) throw this.steerError;
    this.steered.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    fakeSdk.sandboxes.delete(this.sandboxId);
  }

  async getLastAssistantText(): Promise<string | null> {
    return this.lastText;
  }

  async getMessages(): Promise<unknown[]> {
    return this.messages;
  }

  async getState(): Promise<{ isStreaming: boolean }> {
    if (this.paused || this.hangState) return new Promise(() => {});
    return { isStreaming: this.streaming };
  }

  async getSessionStats(): Promise<unknown> {
    if (this.hangSessionStats) return new Promise(() => {});
    return { totalTokens: 42 };
  }

  async spawn(specPath: string, opts: SpawnOpts = {}): Promise<FakeAgent> {
    // Stands in for the real bug (opensandbox-group/OpenSandbox#1831): a second fork() call
    // reaching this sandbox while the first is still in flight is exactly what corrupts a real
    // Docker-runtime commit. spawn.ts's per-parent fork-lock is what's supposed to prevent two
    // calls from ever overlapping here — see the "forks ... are serialized" test in spawn.test.ts.
    if (this.forking) throw new Error(`concurrent fork() on ${this.sandboxId} — OpenSandbox#1831`);
    this.forking = true;
    try {
      fakeSdk.spawnCheck(opts);
      if (this.forkGate) await this.forkGate;
      // OpenSandbox refuses to snapshot a paused sandbox (verified live — V1).
      if (this.paused) {
        throw new Error(
          'OpenSandboxError: {"code":"SNAPSHOT::INVALID_SOURCE_STATE","message":"Snapshot can only be created from a Running sandbox."}',
        );
      }
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as { name?: string };
      // Like the real SDK, a forked child gets its own correlation runId — not alineod's run.
      const child = new FakeAgent({
        name: spec.name ?? "agent",
        runId: `sdk-${crypto.randomUUID()}`,
      });
      this.spawns.push({ specPath, opts, child });
      return child;
    } finally {
      this.forking = false;
    }
  }
}

/** The SDK's own budget refusals (packages/agent/src/agent/{validation,factory}.ts), reproduced verbatim. */
function sdkSpawnCheck(opts: SpawnOpts): void {
  if (opts.spawnDepth === undefined || !Number.isInteger(opts.spawnDepth) || opts.spawnDepth <= 0) {
    throw new Error(
      `Alineo.spawn() refused: spawn depth must be a positive integer (got ${opts.spawnDepth ?? "unset"}). ` +
        `Set "spawnDepth" in this agent's spec, or pass { spawnDepth } explicitly.`,
    );
  }
  if (opts.maxAgents === 0) {
    throw new Error(`Alineo.spawn() refused: max-agents budget exhausted (0 remaining).`);
  }
}

export const fakeSdk = {
  sandboxes: new Map<string, FakeAgent>(),
  /** Applied to the next FakeAgent constructed (start or spawn), then cleared. */
  nextTurn: undefined as FakeTurn | undefined,
  startGate: undefined as Promise<void> | undefined,
  startError: undefined as Error | undefined,
  reattachFails: new Set<string>(),
  /** Fails the first reattach call for this sandbox, then succeeds — a transient hiccup, not a dead bridge. */
  reattachFailsOnce: new Set<string>(),
  resumeFails: new Set<string>(),
  /** Resume fails the way a transient outage does (OpenSandbox unreachable), not "not found". */
  resumeUnavailable: new Set<string>(),
  calls: {
    start: 0,
    reattach: [] as string[],
    reattachOpts: [] as Array<Record<string, unknown> | undefined>,
    resume: [] as string[],
  },
  spawnCheck: sdkSpawnCheck as (opts: SpawnOpts) => void,
  reset(): void {
    this.nextTurn = undefined;
    this.startGate = undefined;
    this.startError = undefined;
    this.reattachFails.clear();
    this.reattachFailsOnce.clear();
    this.resumeFails.clear();
    this.resumeUnavailable.clear();
    this.calls = { start: 0, reattach: [], reattachOpts: [], resume: [] };
    this.spawnCheck = sdkSpawnCheck;
  },
};

// ── @alineo-labs/sandbox fake (the raw-sandbox subsystem, src/engine/sandboxes.ts) ──────────
//
// Separate from FakeAgent/FakeAlineo above (the Pi-agent subsystem) — this stands in for
// `@alineo-labs/sandbox`'s `Sandbox`/`SandboxHandle`, which the sandboxes/workflows routes use
// directly. The real `SandboxHandle` writes every lifecycle event to the SDK ledger adapter
// itself (`packages/core/src/sandbox/core.ts`'s `emit()`); this fake does the same — by hand,
// straight through `sdkAdapter.append()` — so `GET /sandboxes` (which reads the ledger, not
// this fake's own state) sees what a real sandbox would have left behind.
import { sdkAdapter } from "../src/engine/registry";

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
    void sdkAdapter.append({
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
    void sdkAdapter.append({
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
    void sdkAdapter.append({
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

// ── `ai`'s generateObject, for the NL swarm planner (engine/swarm-planner.ts) ────────────────
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

export const FakeAlineo = {
  async start(spec: { name?: string }, opts: { runId: string }): Promise<FakeAgent> {
    fakeSdk.calls.start++;
    if (fakeSdk.startGate) await fakeSdk.startGate;
    if (fakeSdk.startError) throw fakeSdk.startError;
    return new FakeAgent({ name: spec.name ?? "agent", runId: opts.runId });
  },

  async reattach(sandboxId: string, opts?: Record<string, unknown>): Promise<FakeAgent> {
    fakeSdk.calls.reattach.push(sandboxId);
    fakeSdk.calls.reattachOpts.push(opts);
    const agent = fakeSdk.sandboxes.get(sandboxId);
    // The real reattach probes the bridge, which a frozen container can't answer.
    const probeFails = agent?.paused && !opts?.skipReadyCheck;
    if (fakeSdk.reattachFailsOnce.delete(sandboxId)) {
      throw new Error(`sandbox ${sandboxId} reported Paused transiently`);
    }
    if (!agent || fakeSdk.reattachFails.has(sandboxId) || probeFails) {
      throw new Error(`bridge in ${sandboxId} did not answer`);
    }
    return agent;
  },

  async resume(sandboxId: string): Promise<FakeAgent> {
    fakeSdk.calls.resume.push(sandboxId);
    const agent = fakeSdk.sandboxes.get(sandboxId);
    if (fakeSdk.resumeUnavailable.has(sandboxId)) {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }
    if (!agent || fakeSdk.resumeFails.has(sandboxId)) {
      // What OpenSandbox's client really throws: the raw response body as the message.
      throw new Error(
        JSON.stringify({
          code: "DOCKER::SANDBOX_NOT_FOUND",
          message: `Sandbox ${sandboxId} not found.`,
        }),
      );
    }
    // Restarting the bridge execs into the container, which fails while it's frozen.
    if (agent.paused) throw new Error(`sandbox ${sandboxId} is paused`);
    agent.bridgeDown = false;
    return agent;
  },
};
