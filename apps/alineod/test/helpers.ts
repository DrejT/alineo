/** Shared test helpers: drive routes in-process, poll for async state, read the ledger. */
import { createApp } from "../src/app";
import { db, readRunLedger } from "../src/state/db";
import { forget } from "../src/engine/registry";
import { fakeSdk, type FakeAgent } from "./fakes";

export const app = createApp();

export interface CallResult<T> {
  status: number;
  body: T;
}

// oxlint-disable-next-line typescript/no-explicit-any -- route bodies are asserted field by field
export async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<CallResult<T>> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.handle(new Request(`http://alineod.test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Poll until `fn` returns a truthy value, or fail after `timeoutMs`. */
export async function until<T>(
  fn: () => T | Promise<T>,
  what = "condition",
  timeoutMs = 5_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface LedgerEvent {
  seq: number;
  event: string;
  agentId: string | null;
  [field: string]: unknown;
}

export function events(runId: string): LedgerEvent[] {
  return readRunLedger(runId).map((r) => ({
    ...(r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {}),
    seq: r.seq,
    event: r.event,
    agentId: r.agent_id,
  }));
}

export function spec(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, cli: "pi", ...extra };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitProvisioned(agentId: string): Promise<FakeAgent> {
  const view = await until(async () => {
    const r = await call("GET", `/agents/${agentId}`);
    return r.body?.sandboxId ? r.body : r.body?.outcome ? r.body : null;
  }, `${agentId} to provision`);
  if (!view.sandboxId)
    throw new Error(`${agentId} ended before provisioning: ${JSON.stringify(view)}`);
  return fakeSdk.sandboxes.get(view.sandboxId)!;
}

/** `POST /runs`, then wait until the root has a sandbox. */
export async function startRun(body: Record<string, unknown> = {}) {
  const res = await call("POST", "/runs", { spec: spec("root"), ...body });
  if (res.status !== 202) throw new Error(`POST /runs → ${res.status} ${JSON.stringify(res.body)}`);
  const root = await waitProvisioned(res.body.rootAgentId);
  return { runId: res.body.runId as string, rootAgentId: res.body.rootAgentId as string, root };
}

/** `POST /runs/:runId/agents`, then wait until the child has a sandbox. */
export async function spawnChild(
  runId: string,
  parentAgentId: string,
  body: Record<string, unknown> = {},
) {
  const res = await call("POST", `/runs/${runId}/agents`, {
    spec: spec("child"),
    parentAgentId,
    ...body,
  });
  if (res.status !== 202) throw new Error(`spawn → ${res.status} ${JSON.stringify(res.body)}`);
  const agent = await waitProvisioned(res.body.agentId);
  return { agentId: res.body.agentId as string, agent };
}

/** Simulate a fresh process: drop every open agent connection and wipe all state. */
export function wipeState(): void {
  for (const { agent_id } of db
    .query<{ agent_id: string }, []>("SELECT agent_id FROM agents")
    .all()) {
    forget(agent_id);
  }
  db.exec(
    "DELETE FROM ledger; DELETE FROM agents; DELETE FROM handles; DELETE FROM spawn_idempotency;",
  );
}
