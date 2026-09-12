import type { DiagnosticLog, DiagnosticEvent, Metrics } from "@alineo-labs/opensandbox";
import type { SandboxInternal } from "./internal";

/** Return current CPU and memory usage for this sandbox. */
export async function metrics(sb: SandboxInternal): Promise<Metrics> {
  const ec = await sb.getExecClient();

  return ec.getMetrics();
}

/**
 * Stream real-time CPU and memory metrics from execd via SSE.
 *
 * Holds a long-lived connection — break out of the loop when done to avoid
 * leaking the connection. Takes no arguments; there is no way to cancel it
 * other than breaking out of the `for await` loop.
 */
export async function* watchMetrics(sb: SandboxInternal): AsyncGenerator<Metrics> {
  const ec = await sb.getExecClient();

  for await (const ev of ec.watchMetrics()) {
    // SSEEvent's declared shape doesn't include cpu/memory (they're metrics-stream-only
    // fields the wire envelope type doesn't model), so read them defensively rather than
    // asserting the whole event to Metrics -- its `timestamp` type (string) doesn't even
    // match SSEEvent's (number) anyway.
    const cpu = (ev as { cpu?: unknown }).cpu;
    const memory = (ev as { memory?: unknown }).memory;

    if (typeof cpu === "number" && typeof memory === "number") {
      yield { cpu, memory, timestamp: String(ev.timestamp) };
    }
  }
}

/** Return sandbox diagnostic logs (names, sizes, and optional inline content). */
export async function diagnosticLogs(sb: SandboxInternal): Promise<DiagnosticLog[]> {
  return sb.deps.control.getDiagnosticLogs(sb.sandboxId);
}

/** Return sandbox diagnostic events (timestamps, types, and messages). */
export async function diagnosticEvents(sb: SandboxInternal): Promise<DiagnosticEvent[]> {
  return sb.deps.control.getDiagnosticEvents(sb.sandboxId);
}

/**
 * Return a proxied URL and auth headers for a port inside the sandbox.
 *
 * Use this to send HTTP requests to a server running inside the sandbox.
 */
export async function proxy(
  sb: SandboxInternal,
  port: number,
): Promise<{ url: string; headers: Record<string, string> }> {
  const ep = await sb.deps.control.getEndpoint(sb.sandboxId, port, sb.deps.useServerProxy);
  const url = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;

  return { url, headers: ep.headers ?? {} };
}
