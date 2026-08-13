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
    const m = ev as unknown as Metrics;
    if (typeof m.cpu === "number" && typeof m.memory === "number") yield m;
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
