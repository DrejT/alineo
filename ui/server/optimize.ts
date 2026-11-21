/**
 * Rewrite a user's goal into a prompt that suits a swarm: parallel parts, one clear task per agent,
 * a fixed shape for the final reply. The rewrite always runs on the strongest model.
 */
import { resolveModel, scrub } from "./models";
import { AGENTS_ENABLED, MAX_AGENTS } from "./runtime";
import { log as slog, clipText, timer } from "./log";

const CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
/** One try. A stalled call is cut at this point and tried once more, so the user waits about a minute at worst. */
const TIMEOUT_MS = 30_000;
const MAX_GOAL = 4000;

/** Calls per user per minute. Each call spends the server's model quota, and signup is open. */
const PER_MINUTE = 6;
const calls = new Map<string, number[]>();

function throttle(userId: string): void {
  const now = Date.now();
  const recent = (calls.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) throw new Error("Too many rewrites. Wait a minute and try again.");
  recent.push(now);
  calls.set(userId, recent);
}

function system(maxAgents: number): string {
  const workers = Math.max(maxAgents - 1, 0);
  return `You rewrite a user's goal into a prompt for a swarm of AI agents. Output only the rewritten prompt.

How the swarm works. You can rely on these facts:
- One master agent receives the prompt. It can create up to ${workers} worker agents. All agents together, the master included, number at most ${maxAgents}.
- Each agent has its own Linux sandbox with bash, Python and Node, and a real web browser through the tools browser_open, browser_snapshot, browser_click, browser_fill and browser_screenshot.
- Workers run in parallel. Sandboxes do not share files, so a worker gives its work back as its final reply.
- The master creates and manages workers with the swarm command: spawn, status, wait, send.

Rules for the rewrite:
1. Keep the user's intent and topic, and keep every verb and requirement they gave (for example "time", "compare", "suggest"). Keep every URL the user gave. Do not invent URLs, company names, product names, search sites, numbers or facts. If the user gave no sources, tell the agents to find them with the browser, and do not name any.
2. Begin with one sentence that states the objective.
3. Split the work into at most ${workers} parts that can run side by side. Every worker task must be complete on its own. A worker must never need another worker's output. Any step that needs the workers' results, such as comparing, choosing, proposing ideas or writing the report, belongs to the master and happens after the workers finish. For each part, name a worker role and write a task: what to do, what to read or run, what to report, and a length limit.
4. If the goal is small, or cannot be split, say that the master does it alone and creates no workers.
5. If the task needs web pages, tell the agents to use the browser tools and not curl. Name a fallback for a page that is blocked or empty.
6. Say exactly what the final reply must look like: its structure, its length limit, and that it contains nothing else.
7. For research, require the agents to separate what the sources say from what they infer.
8. Write plain text in short imperative sentences. Use no markdown headings and no preamble. Stay under 300 words.`;
}

/** Drop a reasoning block some models put before the answer, and any wrapping quotes or code fence. */
function clean(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  out = out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (/^".*"$/s.test(out)) out = out.slice(1, -1).trim();
  return out;
}

/** Send the request. A timeout, a network error, a 429 or a 5xx gets one more try after a short pause. */
async function callModel(body: string, who: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) return res;
      last = res;
      slog("warn", "optimize.retry", { user: who, attempt: attempt + 1, status: res.status }, true);
    } catch (err) {
      last = err;
      slog("warn", "optimize.retry", { user: who, attempt: attempt + 1, error: clipText(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 200) }, true);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  if (last instanceof Response) return last;
  throw last;
}

export async function optimizeGoal(userId: string, input: { goal: string; maxAgents?: number }): Promise<string> {
  if (!AGENTS_ENABLED) throw new Error("Agents are not enabled on this server.");
  const goal = input.goal.trim();
  if (!goal) throw new Error("Write a goal first.");
  if (goal.length > MAX_GOAL) throw new Error(`The goal is too long (${MAX_GOAL} characters max).`);
  throttle(userId);

  // The rewrite always runs on the strongest model. The user's pick sets the swarm, not this step.
  const model = resolveModel("gemini-3.8-pro");
  const maxAgents = Math.min(Math.max(Math.floor(input.maxAgents ?? 3), 1), MAX_AGENTS);
  const body = JSON.stringify({
    model: model.backend,
    temperature: 0.3,
    max_tokens: 2000,
    messages: [
      { role: "system", content: system(maxAgents) },
      { role: "user", content: `Goal to rewrite:\n\n${goal}` },
    ],
  });
  const elapsed = timer();
  const res = await callModel(body, userId).catch((err) => {
    slog("error", "optimize.failed", { user: userId, ms: elapsed(), error: clipText(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 300) }, true);
    throw new Error(err instanceof Error && err.name === "TimeoutError" ? "The rewrite took too long. Try again." : "The rewrite could not reach the model.");
  });

  if (res.status === 429) throw new Error("The model is busy. Try again in a moment.");
  if (!res.ok) throw new Error("The rewrite failed. Try again.");
  const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string | null } }> } | null;
  const text = clean(data?.choices?.[0]?.message?.content ?? "");
  if (!text) throw new Error("The model returned nothing. Try again, or pick another model.");
  slog("info", "optimize", { user: userId, ms: elapsed(), goalChars: goal.length, outChars: text.length, status: res.status }, true);
  return scrub(text, model);
}
