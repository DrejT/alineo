import type {
  CodeContext,
  CodeLanguage,
  ExecChannel,
  ExecEvent,
  PtyChannel,
} from "@alineo-labs/provider";
import { SandboxError, CommandError } from "../errors";
import type { LedgerEntry } from "../ledger";
import { LedgerEvent } from "../ledger";
import {
  ExecHandle,
  InteractiveExecHandle,
  type ExecDriver,
  type ExecResult,
  type PtyControls,
} from "../exec-handle";
import type { SandboxDeps, ExecOptions, ExecCodeOptions, PendingInteractiveExec } from "./types";
import type { SandboxInternal } from "./internal";
import { resolveExecChannel } from "./resolve";
import { BashSession } from "./bash-session";

/**
 * Owns all private sandbox state (exec sequencing, ledger queue, pause/close
 * flags) plus the exec-stream methods that are most tightly coupled to it.
 * `SandboxHandle` (in `sandbox.ts`) extends this and adds the file/lifecycle/
 * observability methods as thin delegators to sibling modules.
 */
export class SandboxCore implements SandboxInternal {
  readonly sandboxId: string;

  /** The id of the sandbox provider that owns this sandbox (`"opensandbox"`). */
  get provider(): string {
    return this.deps.provider.id;
  }
  readonly name: string;
  readonly deps: SandboxDeps;
  /** Cached exec results for replay mode (populated by `Sandbox.resume()`). */
  readonly replayCache: Map<number, ExecResult>;
  /** Interactive sessions still open at the last checkpoint (populated by `Sandbox.resume()`). */
  readonly pendingInteractive: Map<number, PendingInteractiveExec>;
  readonly openSessionClosers = new Set<() => Promise<void>>();

  private _execClient: ExecChannel | null = null;
  private _seq = 0;
  private _closed = false;
  private _paused = false;
  /**
   * Serializes every `emit()` call for this sandbox so ledger writes complete in the
   * order they were called, regardless of adapter latency. Needed because several call
   * sites (PTY output chunks, `write()`) fire `emit()` without awaiting it — on a
   * network-bound adapter (e.g. Postgres) two such appends can otherwise land out of
   * order even though they were invoked in the right order.
   */
  private _ledgerQueue: Promise<unknown> = Promise.resolve();

  constructor(
    sandboxId: string,
    name: string,
    deps: SandboxDeps,
    replayCache: Map<number, ExecResult> = new Map(),
    pendingInteractive: Map<number, PendingInteractiveExec> = new Map(),
  ) {
    this.sandboxId = sandboxId;
    this.name = name;
    this.deps = deps;
    this.replayCache = replayCache;
    this.pendingInteractive = pendingInteractive;
  }

  isPaused(): boolean {
    return this._paused;
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
  }

  isClosed(): boolean {
    return this._closed;
  }

  setClosed(closed: boolean): void {
    this._closed = closed;
  }

  clearExecClient(): void {
    this._execClient = null;
  }

  /**
   * Force-cancel any exec streams left dangling by `parseSSE`'s early-return
   * optimization (see `ExecClient.disposeConnections()`). No-op if no exec client
   * was ever resolved — deliberately doesn't call `getExecClient()`, which would
   * lazily resolve a brand-new one against a sandbox that's about to be deleted.
   */
  disposeExecClient(): void {
    this._execClient?.disposeConnections();
  }

  nextSeq(): number {
    return ++this._seq;
  }

  /**
   * The channel to this sandbox's `execd`, connecting if there is none yet. `signal` stops the
   * wait for a sandbox that is slow to accept a connection. It does not close a channel that was
   * already connected.
   */
  async getExecClient(signal?: AbortSignal): Promise<ExecChannel> {
    if (this._paused)
      throw new SandboxError(
        "sandbox is paused — call resume() first",
        this.sandboxId,
        "SANDBOX_PAUSED",
      );
    this._execClient ??= await resolveExecChannel(this.deps.provider, this.sandboxId, { signal });
    return this._execClient;
  }

  /** Resolve a fresh terminal channel for a new interactive session. Reuses `getExecClient()`'s readiness wait. */
  async resolvePtyClient(): Promise<PtyChannel> {
    if (this._paused)
      throw new SandboxError(
        "sandbox is paused — call resume() first",
        this.sandboxId,
        "SANDBOX_PAUSED",
      );
    await this.getExecClient(); // ensures execd is up and polling has already succeeded
    if (!this.deps.provider.connectPty) {
      throw new SandboxError(
        `The ${this.deps.provider.id} provider has no interactive terminal`,
        this.sandboxId,
        "CAPABILITY_UNSUPPORTED",
        { details: { capability: "pty", provider: this.deps.provider.id } },
      );
    }
    return this.deps.provider.connectPty(this.sandboxId);
  }

  async waitForRunning(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Starts fast and backs off to 1s — most containers are Running well under
    // one fixed-interval tick, so a flat 1s poll was pure waste in the common case.
    let delay = 100;
    while (Date.now() < deadline) {
      const s = await this.deps.provider.getSandbox(this.sandboxId);
      if (s.state === "running") return;
      if (s.state === "failed" || s.state === "terminated") {
        throw new SandboxError(
          `SandboxHandle entered ${s.nativeState ?? s.state}: ${s.message ?? ""}`,
          this.sandboxId,
          "SANDBOX_START_FAILED",
        );
      }
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 1_000);
    }
    throw new SandboxError(
      `SandboxHandle did not reach Running within ${timeoutMs}ms`,
      this.sandboxId,
      "SANDBOX_START_TIMEOUT",
    );
  }

  async waitForSnapshot(snapshotId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // See waitForRunning — same rationale, capped at the original 2s interval.
    let delay = 100;
    while (Date.now() < deadline) {
      const snap = await this.deps.provider.getSnapshot(snapshotId);
      if (snap.state === "ready") return;
      if (snap.state === "failed") {
        throw new SandboxError(`Snapshot ${snapshotId} failed`, this.sandboxId, "SNAPSHOT_FAILED");
      }
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 2_000);
    }
    throw new SandboxError(
      `Snapshot ${snapshotId} did not become ready within ${timeoutMs}ms`,
      this.sandboxId,
      "SNAPSHOT_TIMEOUT",
    );
  }

  emit(event: LedgerEvent, stepIndex: number, payload?: unknown): Promise<void> {
    // Captured synchronously so the recorded timestamp reflects when this was called,
    // not whenever the queue below gets around to actually writing it.
    const ts = Date.now();
    const entry: LedgerEntry = {
      ts,
      name: this.name,
      sandboxId: this.sandboxId,
      stepIndex,
      event,
      payload,
    };
    // Before the queue, not after: the sink sees the event at the moment it happened, and a
    // slow or broken exporter never delays the write it is exporting. `durable` is left
    // absent because the adapter assigns `alineo_events.id` and does not hand it back — the
    // sandbox session is the aggregate, and surfacing that id is a read-path change for the
    // work that owns storage.
    if (this.deps.sink) {
      try {
        this.deps.sink({
          v: 1,
          ts,
          type: event,
          // No `runId`: a SandboxCore does not carry one. It is recorded in the
          // `sandbox.created` payload at the client level, which is where the aggregate for
          // an SDK session is the sandbox itself rather than a run.
          data: { sandboxId: this.sandboxId, name: this.name, stepIndex, payload },
        });
      } catch {
        // A failing export must never fail the sandbox operation that produced the event.
      }
    }
    const result = this._ledgerQueue.then(() => this.deps.adapter.append(entry));
    // Keep the queue alive even if this append fails — otherwise every future emit()
    // on this sandbox would silently stop writing. The real rejection still propagates
    // to whoever awaits `result` (this call's own return value).
    this._ledgerQueue = result.catch(() => {});
    return result;
  }

  /**
   * Execute a shell command inside the sandbox.
   *
   * Returns an `ExecHandle` — await it for the result, call `.pipe()` to stream
   * stdout, or use `.stdout()` as an async generator. Live execs are logged to
   * the ledger; replayed execs in a resumed sandbox return cached output
   * instantly without re-running and without emitting new ledger events.
   *
   * Pass `{ interactive: true }` to open a live, bidirectional PTY session
   * instead — `cmd` is the program to launch (e.g. `"bash"`), and the returned
   * `InteractiveExecHandle` adds `write()`/`resize()`/`signal()`/`close()`/`attach()`.
   * If the session was still open at the last checkpoint, resuming replays
   * its recorded stdin for real against the freshly restored filesystem
   * before handing control back live.
   *
   * @example
   * ```ts
   * const { exitCode } = await sb.exec("npm test");
   * await sb.exec("npm run build").pipe(process.stdout);
   *
   * const shell = sb.exec("bash", { interactive: true });
   * shell.pipe(process.stdout);
   * shell.write("whoami\n");
   * await shell.close();
   * ```
   */
  exec(cmd: string, opts?: ExecOptions & { interactive?: false }): ExecHandle;
  exec(cmd: string, opts: ExecOptions & { interactive: true }): InteractiveExecHandle;
  // Fallback for callers holding a plain `ExecOptions` whose `interactive` flag isn't
  // known at the type level (e.g. passed through from a queued op) — see `@alineo-labs/workflow`.
  exec(cmd: string, opts: ExecOptions): ExecHandle | InteractiveExecHandle;
  exec(cmd: string, opts: ExecOptions = {}): ExecHandle {
    if (opts.interactive) return this._execInteractive(cmd, opts);

    const seq = ++this._seq;

    const cachedResult = this.replayCache.get(seq);
    if (cachedResult) {
      return new ExecHandle({ type: "replay", result: cachedResult });
    }

    // eslint-disable-next-line typescript/no-this-alias -- arrow functions can't be generators, and stream() below must be a generator, so this is the only way it can reach outer `this`
    const self = this;
    async function* stream(): AsyncGenerator<ExecEvent> {
      opts.signal?.throwIfAborted();
      const baseClient = await self.getExecClient(opts.signal);
      await self.emit(LedgerEvent.ExecStart, seq, { cmd, seq });
      self.deps.hooks?.onExecStart?.(self.sandboxId, seq, cmd);
      // Aborting ends the request. It does not end the process in the sandbox, so ask execd to
      // interrupt it too. Best effort: the caller is already gone, and it only has one signal.
      const execClient = opts.signal ? baseClient.withSignal(opts.signal) : baseClient;
      // `interruptCommand()` names no command: it interrupts whichever one the channel is
      // running. So this listener must not outlive THIS command. If the consumer stops early,
      // or an emit throws, a later abort would otherwise kill an unrelated command.
      const interrupt = () => void baseClient.interruptCommand().catch(() => {});
      opts.signal?.addEventListener("abort", interrupt, { once: true });
      try {
        // base64-encode so newlines/special chars survive the JSON boundary
        const sh = opts.shell ?? self.deps.shell ?? "/bin/sh";
        const command = `echo ${Buffer.from(cmd).toString("base64")} | base64 -d | ${sh}`;
        for await (const ev of execClient.executeCommand({
          command,
          cwd: opts.cwd,
          envs: opts.env,
          timeout: opts.timeoutMs,
        })) {
          await self.emit(LedgerEvent.ExecEvent, seq, { seq, ...ev });
          yield ev;
        }
      } finally {
        opts.signal?.removeEventListener("abort", interrupt);
      }
    }

    return new ExecHandle({
      type: "stream",
      gen: stream(),
      timeoutMs: opts.timeoutMs,
      onDone: async (result) => {
        await self.emit(LedgerEvent.ExecComplete, seq, execCompletedPayload(result, seq));
        self.deps.hooks?.onExecComplete?.(self.sandboxId, seq, result);
        if (opts.strict !== false && result.exitCode !== 0) {
          throw new CommandError(result.exitCode, cmd, self.sandboxId);
        }
      },
    });
  }

  /** Backs `exec(cmd, { interactive: true })` — see that method's docs. */
  private _execInteractive(cmd: string, opts: ExecOptions): InteractiveExecHandle {
    const seq = ++this._seq;

    // Session had already exited before the last checkpoint — nothing live to attach to.
    const cachedResult = this.replayCache.get(seq);
    if (cachedResult) {
      return new InteractiveExecHandle({ type: "replay", result: cachedResult });
    }

    const pending = this.pendingInteractive.get(seq);
    // eslint-disable-next-line typescript/no-this-alias -- arrow functions can't be generators, and stream() below must be a generator, so this is the only way it can reach outer `this`
    const self = this;
    let closer: (() => Promise<void>) | undefined;

    // Logged eagerly, before returning the handle to the caller — write() (below) awaits
    // this same promise before logging its own stdin event, so a write() called
    // synchronously right after exec() returns can never race ExecStart into the ledger
    // (ExecStart itself would otherwise be delayed behind resolvePtyClient()'s network
    // round-trip, while write()'s own ledger append has no such delay).
    const execStartLogged = self.emit(LedgerEvent.ExecStart, seq, {
      cmd,
      seq,
      interactive: true,
      cwd: pending?.cwd ?? opts.cwd,
      env: pending?.env ?? opts.env,
    });
    self.deps.hooks?.onExecStart?.(self.sandboxId, seq, cmd);

    // Resolves only after the PTY is connected and (if resuming) recorded stdin has
    // been fully replayed — guarantees new caller writes queued below never jump ahead
    // of the replay.
    const ptyPromise: Promise<PtyChannel> = (async () => {
      await execStartLogged;
      const pty = await self.resolvePtyClient();

      let onFirstOutput: (() => void) | undefined;
      const firstOutput = new Promise<void>((r) => {
        onFirstOutput = r;
      });

      const sessionId = await pty.create({ cwd: pending?.cwd ?? opts.cwd, command: cmd });
      await pty.connect(
        sessionId,
        (chunk) => {
          onFirstOutput?.();
          onFirstOutput = undefined;
          void self.emit(LedgerEvent.ExecEvent, seq, { seq, type: "stdout", text: chunk });
          push(chunk);
        },
        (exitCode) => {
          finish(exitCode);
        },
      );

      // eslint-disable-next-line typescript/require-await -- closer's declared type is () => Promise<void>; pty.close() is synchronous
      closer = async () => {
        if (closer) self.openSessionClosers.delete(closer);
        pty.close();
      };
      self.openSessionClosers.add(closer);

      // execd reports the pty session as connected before bash has necessarily
      // attached to its controlling terminal — same readiness gap as execd's REST
      // API (see resolveExecClient). Wait for the shell's first output (its initial
      // prompt) before sending anything, so replayed/live input isn't dropped.
      await Promise.race([firstOutput, new Promise<void>((r) => setTimeout(r, 3_000))]);

      for (const line of pending?.stdin ?? []) {
        pty.write(line);
        await new Promise<void>((r) => setTimeout(r, 50));
      }

      return pty;
    })();
    ptyPromise.catch(() => {}); // surfaced via `fail` below — avoid an unhandled-rejection warning

    let push: (chunk: string) => void = () => {};
    let finish: (exitCode: number) => void = () => {};

    const driver: ExecDriver = {
      type: "pty",
      seedStdout: pending?.stdout,
      attach: (p, f, fail) => {
        push = p;
        finish = f;
        ptyPromise.catch(fail);
      },
      onDone: async (result) => {
        if (closer) self.openSessionClosers.delete(closer);
        await self.emit(LedgerEvent.ExecComplete, seq, { exitCode: result.exitCode, seq });
        self.deps.hooks?.onExecComplete?.(self.sandboxId, seq, result);
        if (opts.strict !== false && result.exitCode !== 0) {
          throw new CommandError(result.exitCode, cmd, self.sandboxId);
        }
      },
    };

    const controls: PtyControls = {
      write: (data) => {
        void execStartLogged.then(() =>
          self.emit(LedgerEvent.ExecEvent, seq, { seq, type: "stdin", text: data }),
        );
        void ptyPromise.then((pty) => {
          pty.write(data);
        });
      },
      resize: (cols, rows) => {
        void ptyPromise.then((pty) => {
          pty.resize(cols, rows);
        });
      },
      signal: (name) => {
        void ptyPromise.then((pty) => {
          pty.signal(name);
        });
      },
      close: () => {
        void ptyPromise.then((pty) => {
          pty.close();
        });
      },
    };

    return new InteractiveExecHandle(driver, controls);
  }

  /**
   * Create a code execution context for use with `execCode()`.
   *
   * The code interpreter requires a context for every `execCode()` call. Call
   * this once per session (or once per isolated scope), then pass the returned
   * object as `opts.context` to `execCode()`. Variables defined in one call
   * are visible to subsequent calls sharing the same context.
   *
   * @example
   * ```ts
   * const ctx = await sb.createCodeContext(CodeLanguage.Python);
   * await sb.execCode('x = 42', { context: ctx });
   * await sb.execCode('print(x)', { context: ctx }); // prints 42
   * ```
   */
  async createCodeContext(language: CodeLanguage): Promise<CodeContext> {
    const ec = await this.getExecClient();
    return ec.createContext(language);
  }

  /**
   * Execute code via the sandbox's code interpreter (Python, JS, etc.).
   *
   * Uses the execd `/code` endpoint for stateful, Jupyter-style execution.
   * Contexts persist across calls — use `opts.context` to target a specific one.
   * Create a context first with `sb.createCodeContext(language)`.
   */
  execCode(code: string, opts: ExecCodeOptions = {}): ExecHandle {
    const seq = ++this._seq;

    const cachedResult = this.replayCache.get(seq);
    if (cachedResult) {
      return new ExecHandle({ type: "replay", result: cachedResult });
    }

    // eslint-disable-next-line typescript/no-this-alias -- arrow functions can't be generators, and stream() below must be a generator, so this is the only way it can reach outer `this`
    const self = this;
    async function* stream(): AsyncGenerator<ExecEvent> {
      const execClient = await self.getExecClient();
      await self.emit(LedgerEvent.ExecStart, seq, { code, seq });
      for await (const ev of execClient.executeCode({ code, context: opts.context })) {
        await self.emit(LedgerEvent.ExecEvent, seq, { seq, ...ev });
        yield ev;
      }
    }

    return new ExecHandle({
      type: "stream",
      gen: stream(),
      onDone: async (result) => {
        await self.emit(LedgerEvent.ExecComplete, seq, { exitCode: result.exitCode, seq });
      },
    });
  }

  /**
   * Create a persistent bash session that preserves CWD and env vars across
   * multiple `exec()` calls.
   *
   * Always call `session.close()` when done, or the shell process leaks inside
   * the container. `sandbox.close()` also closes all open sessions automatically.
   *
   * @example
   * ```ts
   * const session = await sb.createSession({ cwd: "/app" });
   * try {
   *   await session.exec("export DB_URL=postgres://localhost/mydb");
   *   await session.exec("npm run migrate").pipe(process.stdout);
   *   await session.exec("npm test").pipe(process.stdout);
   * } finally {
   *   await session.close();
   * }
   * ```
   */
  async createSession(opts?: { cwd?: string }): Promise<BashSession> {
    const ec = await this.getExecClient();
    const resp = await ec.createSession(opts);
    const sessionId = resp.session_id;

    // eslint-disable-next-line typescript/no-this-alias -- arrow functions can't be generators, and stream() below must be a generator, so this is the only way it can reach outer `this`
    const self = this;

    const execInSession = (
      command: string,
      cmdOpts?: { cwd?: string; timeoutMs?: number },
    ): ExecHandle => {
      const seq = ++self._seq;
      async function* stream(): AsyncGenerator<ExecEvent> {
        await self.emit(LedgerEvent.ExecStart, seq, { cmd: command, seq, sessionId });
        self.deps.hooks?.onExecStart?.(self.sandboxId, seq, command);
        for await (const ev of ec.runInSession(sessionId, {
          command,
          cwd: cmdOpts?.cwd,
          timeout: cmdOpts?.timeoutMs,
        })) {
          await self.emit(LedgerEvent.ExecEvent, seq, { seq, ...ev });
          yield ev;
        }
      }
      return new ExecHandle({
        type: "stream",
        gen: stream(),
        onDone: async (result) => {
          await self.emit(LedgerEvent.ExecComplete, seq, { exitCode: result.exitCode, seq });
          self.deps.hooks?.onExecComplete?.(self.sandboxId, seq, result);
          if (result.exitCode !== 0)
            throw new CommandError(result.exitCode, command, self.sandboxId);
        },
      });
    };

    const closeSession = async (): Promise<void> => {
      self.openSessionClosers.delete(closeSession);
      await ec.deleteSession(sessionId);
    };

    this.openSessionClosers.add(closeSession);
    return new BashSession(sessionId, execInSession, closeSession);
  }
}

/**
 * What `exec.completed` records. The optional fields appear only when they say something, so a
 * row for an ordinary command is the same as it was before they existed.
 */
function execCompletedPayload(result: ExecResult, seq: number) {
  return {
    exitCode: result.exitCode,
    seq,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.killed ? { killed: true, signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}
