import type { Metrics, DiagnosticLog, DiagnosticEvent, FileInfo } from "@alineo-labs/opensandbox";
import type { CheckpointInfo } from "../ledger";
import { SandboxCore } from "./core";
import * as files from "./files";
import * as lifecycle from "./lifecycle";
import * as observability from "./observability";

/**
 * A live sandbox container. Returned by `Sandbox.sandbox()` and `Sandbox.resume()`.
 *
 * Call `exec()` to run commands, `checkpoint()` to snapshot state, and `close()`
 * when done. Multiple sandboxes can be held simultaneously — just assign to
 * different variables.
 *
 * @example
 * ```ts
 * const sb = await client.sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } });
 * await sb.exec("npm ci");
 * await sb.checkpoint();
 * await sb.exec("npm test").pipe(process.stdout);
 * await sb.close();
 * ```
 */
export class SandboxHandle extends SandboxCore {
  /** Write a file into the sandbox. */
  async writeFile(path: string, content: string): Promise<void> {
    return files.writeFile(this, path, content);
  }

  /** Read a file from the sandbox as a UTF-8 string. */
  async readFile(path: string): Promise<string> {
    return files.readFile(this, path);
  }

  /** Delete a file from the sandbox. */
  async deleteFile(path: string): Promise<void> {
    return files.deleteFile(this, path);
  }

  /** Move or rename a file inside the sandbox. */
  async moveFile(from: string, to: string): Promise<void> {
    return files.moveFile(this, from, to);
  }

  /** List files in a directory inside the sandbox. */
  async listDirectory(path: string, opts: { depth?: number } = {}) {
    return files.listDirectory(this, path, opts);
  }

  /** Search for files matching a glob pattern inside the sandbox. */
  async searchFiles(pattern: string, path = "/") {
    return files.searchFiles(this, pattern, path);
  }

  /** Create a directory (and parents) inside the sandbox. */
  async createDirectory(path: string): Promise<void> {
    return files.createDirectory(this, path);
  }

  /** Delete a directory inside the sandbox. */
  async deleteDirectory(path: string): Promise<void> {
    return files.deleteDirectory(this, path);
  }

  /** Return metadata for a file or directory (size, type, mode, timestamps). */
  async getFileInfo(path: string): Promise<FileInfo> {
    return files.getFileInfo(this, path);
  }

  /**
   * Replace substrings in one or more files inside the sandbox.
   *
   * More efficient than `readFile` → string replace → `writeFile` for targeted edits.
   *
   * @example
   * ```ts
   * await sb.replaceInFiles([{ path: "/app/config.json", old: "localhost", new: "0.0.0.0" }]);
   * ```
   */
  async replaceInFiles(
    replacements: Array<{ path: string; old: string; new: string }>,
  ): Promise<void> {
    return files.replaceInFiles(this, replacements);
  }

  /**
   * Copy a file from this sandbox into another sandbox.
   *
   * Reads the file as a UTF-8 string and writes it to the same path on the target.
   * Use this to move results between a fork and its origin, or between parallel sandboxes.
   *
   * @example
   * ```ts
   * await sb.transfer("/app/output.json", fork);
   * ```
   */
  async transfer(path: string, target: SandboxHandle): Promise<void> {
    const content = await this.readFile(path);
    await target.writeFile(path, content);
  }

  /**
   * Return a proxied URL and auth headers for a port inside the sandbox.
   *
   * Use this to send HTTP requests to a server running inside the sandbox.
   *
   * @example
   * ```ts
   * await sb.exec("node server.js &");
   * const { url, headers } = await sb.proxy(3000);
   * const res = await fetch(`${url}/health`, { headers });
   * ```
   */
  async proxy(port: number): Promise<{ url: string; headers: Record<string, string> }> {
    return observability.proxy(this, port);
  }

  /** Return current CPU and memory usage for this sandbox. */
  async metrics(): Promise<Metrics> {
    return observability.metrics(this);
  }

  /**
   * Stream real-time CPU and memory metrics from execd via SSE.
   *
   * Holds a long-lived connection — break out of the loop when done to avoid
   * leaking the connection. Takes no arguments; there is no way to cancel it
   * other than breaking out of the `for await` loop.
   *
   * @example
   * ```ts
   * for await (const m of sb.watchMetrics()) {
   *   console.log(m.cpu, m.memory);
   *   if (m.cpu > 0.9) break;
   * }
   * ```
   */
  watchMetrics(): AsyncGenerator<Metrics> {
    return observability.watchMetrics(this);
  }

  /** Return sandbox diagnostic logs (names, sizes, and optional inline content). */
  async diagnosticLogs(): Promise<DiagnosticLog[]> {
    return observability.diagnosticLogs(this);
  }

  /** Return sandbox diagnostic events (timestamps, types, and messages). */
  async diagnosticEvents(): Promise<DiagnosticEvent[]> {
    return observability.diagnosticEvents(this);
  }

  /**
   * Freeze the sandbox container. Releases compute on Kubernetes; on Docker it
   * is a cgroup freeze that preserves in-memory state.
   *
   * All pending exec calls will throw `SandboxError` until `resume()` is called.
   * `close()` remains valid on a paused sandbox.
   */
  async pause(): Promise<void> {
    return lifecycle.pause(this);
  }

  /**
   * Restore a paused sandbox to Running state. The execd endpoint is not
   * re-resolved here — `pause()` clears the cached client, so it's lazily
   * re-resolved on the next call that needs it (e.g. the next `exec()`).
   *
   * On Docker, this unfreezes the container instantly. On Kubernetes, a new pod
   * is created from the OCI snapshot — in-memory process state is not preserved.
   * Polls until the sandbox reports Running before returning.
   */
  async resume(): Promise<void> {
    return lifecycle.resume(this);
  }

  /** Return all checkpoints for this sandbox in creation order. */
  listCheckpoints(): Promise<CheckpointInfo[]> {
    return lifecycle.listCheckpoints(this);
  }

  /**
   * Snapshot the current sandbox and return a new independent `SandboxHandle` from that state.
   *
   * The original sandbox keeps running. Both operate on separate containers restored
   * from the same snapshot. Equivalent to `checkpoint()` followed by `Sandbox.restoreSnapshot()`
   * into a new sandbox, but without closing the original.
   *
   * @example
   * ```ts
   * await sb.exec("npm ci");
   * const fork = await sb.fork("after-install");
   *
   * await sb.exec("npm test");         // runs on original
   * await fork.exec("npm run build");  // runs on fork
   * ```
   *
   * @param runId  Override the forked sandbox's run-correlation ID (see `SandboxDetails.runId`)
   *   instead of inheriting this sandbox's own default.
   */
  async fork(tag?: string, runId?: string): Promise<SandboxHandle> {
    return lifecycle.fork(this, tag, runId);
  }

  /**
   * Capture a snapshot of the sandbox's current filesystem state.
   *
   * Writes a `checkpoint_created` event to the ledger with the snapshot ID and
   * returns the snapshot ID. Use `Sandbox.resume(sandboxId)` to restore from
   * the latest checkpoint, or pass the returned ID to `Sandbox.restoreSnapshot()`.
   */
  async checkpoint(name?: string): Promise<string> {
    return lifecycle.checkpoint(this, name);
  }

  /**
   * Delete the sandbox container and release its resources.
   *
   * Always call `close()` when done — even on error — to avoid leaking containers.
   * Idempotent: subsequent calls are no-ops.
   */
  async close(): Promise<void> {
    return lifecycle.close(this);
  }
}
