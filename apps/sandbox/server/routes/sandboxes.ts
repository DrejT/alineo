import * as registry from "../registry";
import { CapacityError, NotFoundError } from "../registry";
import * as config from "../config";

function errorResponse(err: unknown): Response {
  if (err instanceof CapacityError) return Response.json({ error: err.message }, { status: 409 });
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 500 });
}

export async function listSandboxes(): Promise<Response> {
  const list = Array.from(registry.sandboxes.values()).map((sb) => ({
    id: sb.sandboxId,
    name: sb.name,
  }));
  return Response.json({ sandboxes: list, max: config.MAX_SANDBOXES });
}

export async function createSandbox(): Promise<Response> {
  try {
    const sb = await registry.createSandbox();
    return Response.json({ id: sb.sandboxId, name: sb.name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function deleteSandbox(id: string): Promise<Response> {
  try {
    await registry.deleteSandbox(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

function getSandboxOr404(id: string) {
  // An agent's id is its sandbox id — file/exec ops on it operate on `agent.sandbox`,
  // the same fallback `ws/terminal.ts` uses for the agent shell.
  const sb = registry.sandboxes.get(id) ?? registry.agents.get(id)?.sandbox;
  if (!sb) throw new NotFoundError(`Unknown sandbox ${id}`);
  return sb;
}

export async function listDirectory(id: string, path: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const entries = await sb.listDirectory(path || "/");
    return Response.json({ entries });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function readFile(id: string, path: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const content = await sb.readFile(path);
    return Response.json({ path, content });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function writeFile(id: string, path: string, content: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    await sb.writeFile(path, content);
    return Response.json({ path });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getMetrics(id: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const metrics = await sb.metrics();
    return Response.json(metrics);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function listCheckpoints(id: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const checkpoints = await sb.listCheckpoints();
    return Response.json({ checkpoints });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createCheckpoint(id: string): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const snapshotId = await sb.checkpoint();
    return Response.json({ snapshotId });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getPreview(id: string, port: number): Promise<Response> {
  try {
    const sb = getSandboxOr404(id);
    const proxy = await sb.proxy(port);
    return Response.json(proxy);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Run one command to completion, streaming stdout as it arrives. Emits
 * newline-delimited SSE frames: `{ type: "stdout", text }` per chunk, then a
 * terminal `{ type: "exit", exitCode, stderr }` (or `{ type: "error", message }`).
 * The guided playground workflows drive this instead of the PTY WebSocket so each
 * step has a deterministic exit code to branch on.
 */
export async function execCommand(id: string, command: string): Promise<Response> {
  let sb;
  try {
    sb = getSandboxOr404(id);
  } catch (err) {
    return errorResponse(err);
  }
  if (typeof command !== "string" || !command.trim()) {
    return Response.json({ error: "missing command" }, { status: 400 });
  }
  if (!config.ALLOWED_EXEC_COMMANDS.has(command)) {
    return Response.json({ error: "command not allowed" }, { status: 403 });
  }

  const handle = sb.exec(command, { timeoutMs: config.EXEC_TIMEOUT_MS });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const chunk of handle.stdout()) send({ type: "stdout", text: chunk });
        const result = await handle.result();
        send({ type: "exit", exitCode: result.exitCode, stderr: result.stderr });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function forkSandbox(id: string, tag?: string): Promise<Response> {
  try {
    const child = await registry.forkSandbox(id, tag);
    return Response.json({ id: child.sandboxId, name: child.name }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
