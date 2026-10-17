import type { ExecChannel, ExecEvent } from "@alineo-labs/provider";

const hasEnding = (text: string) => /[\r\n]/.test(text);
const isOutput = (ev: ExecEvent): ev is ExecEvent & { text: string } =>
  (ev.type === "stdout" || ev.type === "stderr") && typeof ev.text === "string";
const isTerminal = (ev: ExecEvent) => ev.type === "error" || ev.type === "execution_complete";

/**
 * Restores the line endings that `execd` before 1.1.1 dropped.
 *
 * Those versions send one stdout event per line with the newline removed, so `echo one; echo
 * two` arrives as `"one"` then `"two"` and anything that concatenates events reads `"onetwo"`
 * (fixed upstream in OpenSandbox 380322ba). `alineo init` pins a version that is fine, but an
 * install keeps the `execd_image` in its own `server.toml`, so old servers are still out there.
 *
 * This is an OpenSandbox quirk, so it lives here and not in core, which joins events as they are.
 *
 * **How it decides.** A server that keeps endings sends every complete line with one, and sends
 * an ending-less event only as the last fragment. So a stream with two or more ending-less events
 * of one kind and *no event of that kind that has an ending* can only be a server that dropped
 * them. Those events are held until the stream's terminal event, and then released with `\n`
 * appended. The first event that does carry an ending proves the server keeps them: held events
 * are released as they were, and the rest of the stream is not touched. A single ending-less
 * event is left alone, because it is also what `printf abc` looks like on a good server.
 *
 * **What it learns.** One verdict per instance, which is one per channel and so per sandbox.
 * Once a stream has proved the server drops endings, later streams are repaired as they arrive,
 * not held. Once one has proved it keeps them, nothing is ever held again.
 *
 * **Known limit.** On a server that drops endings, a final fragment printed on purpose without a
 * newline (`printf abc`) gets one added after the first stream has taught this instance. There is
 * no telling the two apart from the events alone.
 */
export class LineEndingRepair {
  private dropsEndings: boolean | undefined;

  async *repair(events: AsyncGenerator<ExecEvent>): AsyncGenerator<ExecEvent> {
    if (this.dropsEndings === false) {
      yield* events;
      return;
    }

    if (this.dropsEndings === true) {
      for await (const ev of events)
        yield isOutput(ev) && !hasEnding(ev.text) ? terminated(ev) : ev;
      return;
    }

    // Verdict unknown: hold ending-less output until something settles it.
    const held: Array<ExecEvent & { text: string }> = [];
    let sawEnding = false;
    for await (const ev of events) {
      if (isOutput(ev)) {
        if (hasEnding(ev.text)) {
          if (!sawEnding) {
            sawEnding = true;
            this.dropsEndings = false;
            for (const h of held.splice(0)) yield h;
          }
          yield ev;
        } else if (sawEnding) {
          yield ev; // a trailing fragment on a server that keeps endings
        } else {
          held.push(ev);
        }
        continue;
      }
      if (isTerminal(ev) && held.length > 0) yield* this.release(held);
      yield ev;
    }
    // The stream ended with no terminal event. Do not lose what was held.
    if (held.length > 0) yield* this.release(held);
  }

  /** Decide, for each kind of output, whether the held events were stripped lines. */
  private *release(held: Array<ExecEvent & { text: string }>): Generator<ExecEvent> {
    const count = { stdout: 0, stderr: 0 } as Record<string, number>;
    for (const ev of held) count[ev.type] = (count[ev.type] ?? 0) + 1;
    const stripped = (type: string) => (count[type] ?? 0) >= 2;
    if (stripped("stdout") || stripped("stderr")) this.dropsEndings = true;
    for (const ev of held.splice(0)) yield stripped(ev.type) ? terminated(ev) : ev;
  }
}

function terminated(ev: ExecEvent & { text: string }): ExecEvent {
  return { ...ev, text: `${ev.text}\n` };
}

/**
 * `inner`, with the line endings of command and session output restored where `execd` dropped
 * them. Everything else, code execution included, is passed through unchanged.
 *
 * `withSignal` copies share one {@link LineEndingRepair}: they talk to the same server.
 */
export function withLineEndingRepair(
  inner: ExecChannel,
  repair: LineEndingRepair = new LineEndingRepair(),
): ExecChannel {
  return {
    withSignal: (signal) => withLineEndingRepair(inner.withSignal(signal), repair),
    disposeConnections: () => inner.disposeConnections(),
    executeCommand: (request) => repair.repair(inner.executeCommand(request)),
    runInSession: (sessionId, request) => repair.repair(inner.runInSession(sessionId, request)),
    executeCode: (request) => inner.executeCode(request),
    interruptCommand: () => inner.interruptCommand(),
    listContexts: (language) => inner.listContexts(language),
    createContext: (language) => inner.createContext(language),
    createSession: (request) => inner.createSession(request),
    deleteSession: (sessionId) => inner.deleteSession(sessionId),
    getFileInfo: (path) => inner.getFileInfo(path),
    deleteFile: (path) => inner.deleteFile(path),
    moveFile: (from, to) => inner.moveFile(from, to),
    searchFiles: (pattern, path) => inner.searchFiles(pattern, path),
    replaceInFiles: (replacements) => inner.replaceInFiles(replacements),
    uploadFile: (path, content) => inner.uploadFile(path, content),
    downloadFile: (path) => inner.downloadFile(path),
    listDirectory: (path, depth) => inner.listDirectory(path, depth),
    createDirectory: (path) => inner.createDirectory(path),
    deleteDirectory: (path) => inner.deleteDirectory(path),
    getMetrics: () => inner.getMetrics(),
    watchMetrics: () => inner.watchMetrics(),
  };
}
