/** Minimal alineod HTTP client for benchmarks. alineod resolves `${VAR}` in spec.env inside its own container. */

export const ALINEOD = process.env.ALINEOD_URL ?? "http://127.0.0.1:4600";

export interface AgentSummary {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  state: string;
  outcome: string | null;
  specName: string;
  sandboxId: string | null;
}

export interface Result {
  agentId: string;
  state: "pending" | "settled";
  outcome: string | null;
  result: string | null;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; body: T }> {
  const res = await fetch(ALINEOD + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export interface SpecOptions {
  name: string;
  model?: string;
  cpu?: string;
  memory?: string;
  extra?: Record<string, unknown>;
}

/**
 * A Pi agent. Provider and model come from BENCH_AGENT_PROVIDER / BENCH_AGENT_MODEL (default: Groq's
 * gpt-oss-20b). The key is a `${VAR}` placeholder resolved inside alineod's container, never the value.
 */
export function agentSpec(o: SpecOptions): Record<string, unknown> {
  const provider = process.env.BENCH_AGENT_PROVIDER ?? "groq";
  const keyVar = provider === "google" ? "GEMINI_API_KEY" : `${provider.toUpperCase()}_API_KEY`;
  const defaultModel = provider === "groq" ? "openai/gpt-oss-20b" : "gemini-3.5-flash-lite";
  return {
    name: o.name,
    harness: "pi",
    harnessVersion: "1.2.0",
    provider,
    model: o.model ?? process.env.BENCH_AGENT_MODEL ?? defaultModel,
    env: { [keyVar]: "${" + keyVar + "}" },
    resources: { cpu: o.cpu ?? "500m", memory: o.memory ?? "1Gi" },
    ...o.extra,
  };
}

/**
 * Groq validates each tool call against the tool's schema and rejects it when an argument is left out, which
 * ended 16 of 36 agent turns in the first Groq suite (`missing properties: 'timeout'`, `'offset'`, `'limit'`).
 * This note asks the model to always send every argument. It says nothing about any task; set
 * BENCH_TOOL_HINT=0 to switch it off.
 */
const TOOL_HINT =
  "Tool-use note: always send every parameter of a tool call. For the bash tool include `timeout` (seconds, for " +
  "example 60); for the read tool include both `offset` and `limit` and no other parameter names.\n\n";

const withToolHint = (prompt: string) =>
  process.env.BENCH_TOOL_HINT === "0" ? prompt : TOOL_HINT + prompt;

export async function startRun(spec: Record<string, unknown>, prompt: string) {
  const r = await call<{ runId: string; rootAgentId: string; error?: unknown }>("POST", "/runs", {
    spec,
    prompt: withToolHint(prompt),
  });
  if (r.status >= 300) throw new Error(`POST /runs ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function getRun(runId: string) {
  const r = await call<{ runId: string; rootAgentId: string | null; agents: AgentSummary[] }>(
    "GET",
    `/runs/${runId}`,
  );
  if (r.status !== 200) throw new Error(`GET /runs/${runId} ${r.status}`);
  return r.body;
}

export async function deleteRun(runId: string): Promise<void> {
  await call("DELETE", `/runs/${runId}`).catch(() => undefined);
}

/** Poll until the agent's result is settled; returns timings so callers can report latency. */
export async function waitResult(agentId: string, timeoutMs = 600_000): Promise<Result> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await call<Result>("GET", `/agents/${agentId}/result`, undefined, 15_000);
      if (r.body?.state === "settled") return r.body;
    } catch {
      // alineod may be restarting; keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`agent ${agentId} did not settle within ${timeoutMs}ms`);
}

export async function waitHealthy(timeoutMs = 120_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(ALINEOD + "/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return Date.now() - t0;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("alineod did not become healthy");
}
