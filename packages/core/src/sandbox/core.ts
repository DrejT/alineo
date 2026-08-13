import { ExecClient, PtyClient, SnapshotState, SandboxState } from "@alineo-labs/opensandbox";
import type { SSEEvent, RunInSessionRequest } from "@alineo-labs/opensandbox";
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
import { resolveExecClient } from "./resolve";
import { BashSession } from "./bash-session";

/**
 * Owns all private sandbox state (exec sequencing, ledger queue, pause/close
 * flags) plus the exec-stream methods that are most tightly coupled to it.
 * `Sandbox` (in `sandbox.ts`) extends this and adds the file/lifecycle/
 * observability methods as thin delegators to sibling modules.
 */
export class SandboxCore implements SandboxInternal {
  readonly sandboxId: string;
  readonly name: string;
  readonly deps: SandboxDeps;
  /** Cached exec results for replay mode (populated by `Alineo.resume()`). */
  readonly replayCache: Map<number, ExecResult>;
  /** Interactive sessions still open at the last checkpoint (populated by `Alineo.resume()`). */
  readonly pendingInteractive: Map<number, PendingInteractiveExec>;
  readonly openSessionClosers = new Set<() => Promise<void>>();

  private _execClient: ExecClient | null = null;
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

  async getExecClient(): Promise<ExecClient> {
    if (this._paused)
      throw new SandboxError("sandbox is paused — call resume() first", this.sandboxId);
    if (!this._execClient) {
      this._execClient = await resolveExecClient(
        this.deps.control,
        this.sandboxId,
        this.deps.useServerProxy,
      );
    }
    return this._execClient;
  }

  /** Resolve a fresh `PtyClient` for a new interactive session. Reuses `getExecClient()`'s readiness wait. */
  async resolvePtyClient(): Promise<PtyClient> {
    if (this._paused)
      throw new SandboxError("sandbox is paused — call resume() first", this.sandboxId);
    await this.getExecClient(); // ensures execd is up and polling has already succeeded
    const ep = await this.deps.control.getEndpoint(this.sandboxId, 44772, this.deps.useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const token = ep.headers?.["X-EXECD-ACCESS-TOKEN"] ?? "";
    return new PtyClient({ baseUrl, accessToken: token });
  }

  async waitForRunning(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Starts fast and backs off to 1s — most containers are Running well under
    // one fixed-interval tick, so a flat 1s poll was pure waste in the common case.
    let delay = 100;
    while (Date.now() < deadline) {
      const s = await this.deps.control.getSandbox(this.sandboxId);
      if (s.status.state === SandboxState.Running) return;
      if (s.status.state === SandboxState.Failed || s.status.state === SandboxState.Terminated) {
        throw new SandboxError(
          `Sandbox entered ${s.status.state}: ${s.status.message ?? ""}`,
          this.sandboxId,
        );
      }
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 1_000);
    }
    throw new SandboxError(`Sandbox did not reach Running within ${timeoutMs}ms`, this.sandboxId);
  }

  async waitForSnapshot(snapshotId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // See waitForRunning — same rationale, capped at the original 2s interval.
    let delay = 100;
    while (Date.now() < deadline) {
      const snap = await this.deps.control.getSnapshot(snapshotId);
      if (snap.state === SnapshotState.Ready) return;
      if (snap.state === SnapshotState.Failed) {
        throw new SandboxError(`Snapshot ${snapshotId} failed`, this.sandboxId);
      }
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 2_000);
    }
    throw new SandboxError(
      `Snapshot ${snapshotId} did not become ready within ${timeoutMs}ms`,
      this.sandboxId,
    );
  }

  emit(event: LedgerEvent, stepIndex: number, payload?: unknown): Promise<void> {
    // Captured synchronously so the recorded timestamp reflects when this was called,
    // not whenever the queue below gets around to actually writing it.
    const entry: LedgerEntry = {
      ts: Date.now(),
      name: this.name,
      sandboxId: this.sandboxId,
      stepIndex,
      event,
      payload,
    };
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

    if (this.replayCache.has(seq)) {
      return new ExecHandle({ type: "replay", result: this.replayCache.get(seq)! });
    }

    const self = this;
    async function* stream(): AsyncGenerator<SSEEvent> {
      const execClient = await self.getExecClient();
      await self.emit(LedgerEvent.ExecStart, seq, { cmd, seq });
      self.deps.hooks?.onExecStart?.(self.sandboxId, seq, cmd);
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
    }

    return new ExecHandle({
      type: "stream",
      gen: stream(),
      onDone: async (result) => {
        await self.emit(LedgerEvent.ExecComplete, seq, { exitCode: result.exitCode, seq });
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
    if (this.replayCache.has(seq)) {
      return new InteractiveExecHandle({ type: "replay", result: this.replayCache.get(seq)! });
    }

    const pending = this.pendingInteractive.get(seq);
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
    const ptyPromise: Promise<PtyClient> = (async () => {
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
        (exitCode) => finish(exitCode),
      );

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
        void ptyPromise.then((pty) => pty.write(data));
      },
      resize: (cols, rows) => {
        void ptyPromise.then((pty) => pty.resize(cols, rows));
      },
      signal: (name) => {
        void ptyPromise.then((pty) => pty.signal(name));
      },
      close: () => {
        void ptyPromise.then((pty) => pty.close());
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
  async createCodeContext(
    language: import("@alineo-labs/opensandbox").CodeLanguage,
  ): Promise<import("@alineo-labs/opensandbox").CodeContext> {
    const ec = await this.getExecClient();
    return ec.createContext(language as string);
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

    if (this.replayCache.has(seq)) {
      return new ExecHandle({ type: "replay", result: this.replayCache.get(seq)! });
    }

    const self = this;
    async function* stream(): AsyncGenerator<SSEEvent> {
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

    const self = this;

    const execInSession = (
      command: string,
      cmdOpts?: { cwd?: string; timeoutMs?: number },
    ): ExecHandle => {
      const seq = ++self._seq;
      async function* stream(): AsyncGenerator<SSEEvent> {
        await self.emit(LedgerEvent.ExecStart, seq, { cmd: command, seq, sessionId });
        self.deps.hooks?.onExecStart?.(self.sandboxId, seq, command);
        for await (const ev of ec.runInSession(sessionId, {
          command,
          cwd: cmdOpts?.cwd,
          timeout: cmdOpts?.timeoutMs,
        } as RunInSessionRequest)) {
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
