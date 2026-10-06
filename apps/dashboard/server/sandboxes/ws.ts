/**
 * Per-connection state for the sandbox WebSocket routes (interactive terminal + live metrics).
 * Kept out of `routes/sandboxes.ts` so the route file only
 * declares routes.
 */
import type { InteractiveExecHandle } from "@alineo-labs/core";
import { resolveLive } from "./registry";
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("dashboard");

const execHandles = new Map<string, InteractiveExecHandle>();
const metricsStops = new Map<string, () => void>();

export async function openExecSession(
  wsId: string,
  sandboxId: string,
  send: (chunk: string) => void,
): Promise<boolean> {
  try {
    const sb = await resolveLive(sandboxId);
    const handle = sb.exec("bash", { interactive: true });
    execHandles.set(wsId, handle);
    void pumpStdout(wsId, handle, send);
    return true;
  } catch (err) {
    log.debug("terminal ws: sandbox unavailable", { sandboxId, err });
    return false;
  }
}

async function pumpStdout(
  wsId: string,
  handle: InteractiveExecHandle,
  send: (chunk: string) => void,
): Promise<void> {
  try {
    for await (const chunk of handle.stdout()) send(chunk);
  } catch {
    // session ended with an error — fall through
  } finally {
    execHandles.delete(wsId);
  }
}

export function writeExec(wsId: string, data: string): void {
  execHandles.get(wsId)?.write(data);
}

export function resizeExec(wsId: string, cols: number, rows: number): void {
  execHandles.get(wsId)?.resize(cols, rows);
}

export function signalExec(wsId: string, name: string): void {
  execHandles.get(wsId)?.signal(name);
}

export async function closeExecSession(wsId: string): Promise<void> {
  const handle = execHandles.get(wsId);
  execHandles.delete(wsId);
  await handle?.close().catch(() => {});
}

export async function openMetricsSession(
  wsId: string,
  sandboxId: string,
  send: (chunk: string) => void,
): Promise<boolean> {
  try {
    const sb = await resolveLive(sandboxId);
    const gen = sb.watchMetrics();
    metricsStops.set(wsId, () => void gen.return(undefined));
    (async () => {
      try {
        for await (const m of gen) send(JSON.stringify(m));
      } catch {
        // execd connection dropped — client reconnects
      }
    })();
    return true;
  } catch (err) {
    log.debug("metrics ws: sandbox unavailable", { sandboxId, err });
    return false;
  }
}

export function closeMetricsSession(wsId: string): void {
  metricsStops.get(wsId)?.();
  metricsStops.delete(wsId);
}
