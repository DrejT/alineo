import { SSEEventType } from "@alineo-labs/opensandbox";
import type { SSEEvent } from "@alineo-labs/opensandbox";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecDriver =
  | { type: "stream"; gen: AsyncGenerator<SSEEvent>; onDone: (r: ExecResult) => Promise<void> }
  | { type: "replay"; result: ExecResult }
  | {
      type: "pty";
      /** Output already recorded before this handle was created (e.g. resumed from ledger) — shown as scrollback before live output resumes. */
      seedStdout?: string;
      /** Wire up push-based output/exit/failure callbacks. Called once, synchronously. */
      attach: (
        push: (chunk: string) => void,
        finish: (exitCode: number) => void,
        fail: (err: unknown) => void,
      ) => void;
      onDone: (r: ExecResult) => Promise<void>;
    };

/** Live input/control surface for an `InteractiveExecHandle`. Absent for finished/replayed sessions. */
export interface PtyControls {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  signal(name: string): void;
  close(): void;
}

/**
 * Returned by `SandboxHandle.exec()` and `SandboxHandle.execCode()`.
 *
 * Implements `PromiseLike<ExecResult>` so `await sb.exec(...)` works naturally.
 * Also exposes `pipe()`, `stdout()`, and `result()` for streaming output.
 *
 * @example
 * ```ts
 * // simple await
 * const { exitCode } = await sb.exec("npm test");
 *
 * // stream to stdout
 * await sb.exec("npm run build").pipe(process.stdout);
 *
 * // async generator
 * for await (const chunk of sb.exec("npm test").stdout()) process.stdout.write(chunk);
 * ```
 */
export class ExecHandle implements PromiseLike<ExecResult> {
  private readonly _promise: Promise<ExecResult>;
  private readonly _chunks: string[] = [];
  private _wakeup: (() => void) | null = null;
  private _done = false;
  private _err: unknown;
  private _hasErr = false;

  constructor(driver: ExecDriver) {
    if (driver.type === "replay") {
      if (driver.result.stdout) this._chunks.push(driver.result.stdout);
      this._done = true;
      this._promise = Promise.resolve(driver.result);
    } else if (driver.type === "pty") {
      this._promise = this._drainPty(driver);
      this._promise.catch(() => {});
    } else {
      this._promise = this._drain(driver.gen, driver.onDone);
      this._promise.catch(() => {});
    }
  }

  private _drainPty(driver: Extract<ExecDriver, { type: "pty" }>): Promise<ExecResult> {
    if (driver.seedStdout) this._chunks.push(driver.seedStdout);
    return new Promise((resolve, reject) => {
      driver.attach(
        (chunk) => {
          this._chunks.push(chunk);
          this._notify();
        },
        (exitCode) => {
          this._done = true;
          const result: ExecResult = { stdout: this._chunks.join(""), stderr: "", exitCode };
          this._notify();
          driver.onDone(result).then(
            () => {
              resolve(result);
            },
            (err) => {
              this._err = err;
              this._hasErr = true;
              reject(err);
            },
          );
        },
        (err) => {
          this._done = true;
          this._err = err;
          this._hasErr = true;
          this._notify();
          reject(err);
        },
      );
    });
  }

  private async _drain(
    gen: AsyncGenerator<SSEEvent>,
    onDone: (r: ExecResult) => Promise<void>,
  ): Promise<ExecResult> {
    const stderr: string[] = [];
    let exitCode = 0;
    try {
      for await (const ev of gen) {
        if (ev.type === SSEEventType.Stdout && ev.text) {
          this._chunks.push(ev.text);
          this._notify();
        }
        if (ev.type === SSEEventType.Stderr && ev.text) {
          stderr.push(ev.text);
        }
        if (ev.type === SSEEventType.Error && ev.error?.evalue !== undefined) {
          const code = Number(ev.error.evalue);
          if (!isNaN(code)) exitCode = code;
        }
      }
    } catch (err) {
      this._err = err;
      this._hasErr = true;
      throw err;
    } finally {
      this._done = true;
      this._notify();
    }

    const result: ExecResult = {
      stdout: this._chunks.join(""),
      stderr: stderr.join(""),
      exitCode,
    };
    await onDone(result);
    return result;
  }

  private _notify(): void {
    const fn = this._wakeup;
    this._wakeup = null;
    fn?.();
  }

  then<T, E>(
    onfulfilled?: ((value: ExecResult) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null,
  ): Promise<T | E> {
    return this._promise.then(onfulfilled, onrejected);
  }

  /** Resolve the full result: `{ stdout, stderr, exitCode }`. */
  result(): Promise<ExecResult> {
    return this._promise;
  }

  /** Async generator yielding stdout chunks as they arrive. */
  async *stdout(): AsyncGenerator<string> {
    let pos = 0;
    while (true) {
      while (pos < this._chunks.length) yield this._chunks[pos++];
      if (this._done) break;
      await new Promise<void>((r) => {
        this._wakeup = r;
      });
    }
    while (pos < this._chunks.length) yield this._chunks[pos++];
    if (this._hasErr) throw this._err;
  }

  /** Pipe stdout to any writable with a `write(chunk: string)` method. */
  async pipe(writable: { write(chunk: string): unknown }): Promise<void> {
    for await (const chunk of this.stdout()) writable.write(chunk);
  }
}

/** Minimal structural readable — matches `process.stdin` without depending on `@types/node`. */
export interface AttachableSource {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * Returned by `SandboxHandle.exec(cmd, { interactive: true })`.
 *
 * Extends `ExecHandle` with the input/control side of a live PTY session:
 * `write()` sends input, `resize()`/`signal()` control the terminal, `close()`
 * ends the session, and `attach()` pumps a real readable/writable pair (e.g.
 * `process.stdin`/`process.stdout`) for full human passthrough.
 *
 * `stdout()`/`pipe()`/`result()`/`await` are inherited unchanged from `ExecHandle`.
 * For a session that had already finished before a checkpoint (replayed, not
 * live), `write()`/`resize()`/`signal()`/`close()` are no-ops — there is
 * nothing left to attach to.
 *
 * @example
 * ```ts
 * const shell = sb.exec("bash", { interactive: true });
 * shell.pipe(process.stdout);
 * shell.write("whoami\n");
 * await shell.close();
 *
 * // or full human passthrough:
 * await sb.exec("bash", { interactive: true }).attach(process.stdin, process.stdout);
 * ```
 */
export class InteractiveExecHandle extends ExecHandle {
  private readonly _controls?: PtyControls;

  constructor(driver: ExecDriver, controls?: PtyControls) {
    super(driver);
    this._controls = controls;
  }

  /** Send input to the running process. No-op if the session already ended. */
  write(data: string | Uint8Array): void {
    this._controls?.write(typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  /** Resize the PTY. No-op if the session already ended. */
  resize(cols: number, rows: number): void {
    this._controls?.resize(cols, rows);
  }

  /** Send a signal (e.g. `"SIGINT"`) to the running process. No-op if the session already ended. */
  signal(name: string): void {
    this._controls?.signal(name);
  }

  /** Force-end the session. No-op if it already ended on its own. */
  // eslint-disable-next-line typescript/require-await -- kept async/Promise-returning for a consistent await-able API alongside this class's other async methods; the underlying control is synchronous
  async close(): Promise<void> {
    this._controls?.close();
  }

  /**
   * Pump a real readable/writable pair for full terminal passthrough — e.g.
   * `shell.attach(process.stdin, process.stdout)` drops a human straight into
   * the live remote shell. Resolves when the session ends.
   */
  async attach(
    readable: AttachableSource,
    writable: { write(chunk: string): unknown },
  ): Promise<void> {
    const onData = (chunk: Buffer | string) => {
      this.write(chunk.toString());
    };
    readable.on("data", onData);
    try {
      await this.pipe(writable);
    } finally {
      readable.off("data", onData);
    }
  }
}
