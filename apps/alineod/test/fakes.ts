/**
 * A scriptable stand-in for the `alineo` SDK, installed by setup.ts via `mock.module`.
 *
 * `FakeAgent` mirrors the slice of the `Alineo` instance API alineod calls; `FakeAlineo` mirrors
 * the static constructors (`load` / `reattach` / `resume`). Every agent ever created is kept in
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

  readonly sandbox = {
    pause: async (): Promise<void> => {
      if (this.pauseError) throw this.pauseError;
      this.paused = true;
    },
    resume: async (): Promise<void> => {
      this.paused = false;
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
      const child = new FakeAgent({ name: spec.name ?? "agent", runId: this.runId });
      this.spawns.push({ specPath, opts, child });
      return child;
    } finally {
      this.forking = false;
    }
  }
}

/** The SDK's own budget refusals (packages/agent/src/agent/{validation,factory}.ts), reproduced verbatim. */
export function sdkSpawnCheck(opts: SpawnOpts): void {
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
  /** Applied to the next FakeAgent constructed (load or spawn), then cleared. */
  nextTurn: undefined as FakeTurn | undefined,
  loadGate: undefined as Promise<void> | undefined,
  loadError: undefined as Error | undefined,
  reattachFails: new Set<string>(),
  resumeFails: new Set<string>(),
  calls: {
    load: 0,
    reattach: [] as string[],
    reattachOpts: [] as Array<Record<string, unknown> | undefined>,
    resume: [] as string[],
  },
  spawnCheck: sdkSpawnCheck as (opts: SpawnOpts) => void,
  reset(): void {
    this.nextTurn = undefined;
    this.loadGate = undefined;
    this.loadError = undefined;
    this.reattachFails.clear();
    this.resumeFails.clear();
    this.calls = { load: 0, reattach: [], reattachOpts: [], resume: [] };
    this.spawnCheck = sdkSpawnCheck;
  },
};

export const FakeAlineo = {
  async load(spec: { name?: string }, opts: { runId: string }): Promise<FakeAgent> {
    fakeSdk.calls.load++;
    if (fakeSdk.loadGate) await fakeSdk.loadGate;
    if (fakeSdk.loadError) throw fakeSdk.loadError;
    return new FakeAgent({ name: spec.name ?? "agent", runId: opts.runId });
  },

  async reattach(sandboxId: string, opts?: Record<string, unknown>): Promise<FakeAgent> {
    fakeSdk.calls.reattach.push(sandboxId);
    fakeSdk.calls.reattachOpts.push(opts);
    const agent = fakeSdk.sandboxes.get(sandboxId);
    // The real reattach probes the bridge, which a frozen container can't answer.
    const probeFails = agent?.paused && !opts?.skipReadyCheck;
    if (!agent || fakeSdk.reattachFails.has(sandboxId) || probeFails) {
      throw new Error(`bridge in ${sandboxId} did not answer`);
    }
    return agent;
  },

  async resume(sandboxId: string): Promise<FakeAgent> {
    fakeSdk.calls.resume.push(sandboxId);
    const agent = fakeSdk.sandboxes.get(sandboxId);
    if (!agent || fakeSdk.resumeFails.has(sandboxId)) {
      throw new Error(`sandbox ${sandboxId} not found`);
    }
    // Restarting the bridge execs into the container, which fails while it's frozen.
    if (agent.paused) throw new Error(`sandbox ${sandboxId} is paused`);
    agent.bridgeDown = false;
    return agent;
  },
};
