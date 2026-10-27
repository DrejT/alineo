/**
 * Groq's free tier caps each model at a daily token budget and then answers every call with a 429 that alineod
 * only reports as a failed turn. Probe with one tiny call so a capped run stops with a clear reason instead of
 * burning retries and being scored as task failures. Skipped when no key is available in this process.
 */
import { execFileSync } from "node:child_process";

export class ProviderCapReached extends Error {}

/**
 * The tiny probe below passes even when the day's remaining tokens cannot fit a real agent request (a daily limit
 * counts the size of each request), which let one suite burn 17 runs on retries. alineod logs the provider's
 * exact 429 text for every failed turn, so a "tokens per day" line in the last few minutes is conclusive.
 */
function assertNoRecentCap(sinceMinutes = 8): void {
  try {
    const out = execFileSync("docker", ["logs", "--since", `${sinceMinutes}m`, process.env.ALINEOD_CONTAINER ?? "alineo-alineod"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (/tokens per day \(TPD\)/.test(out)) throw new ProviderCapReached("provider daily token cap reached (tokens per day 429 in alineod logs)");
  } catch (e) {
    if (e instanceof ProviderCapReached) throw e;
    // docker unavailable: fall through to the probe
  }
}

export async function assertProviderBudget(): Promise<void> {
  assertNoRecentCap();
  const key = process.env.GROQ_API_KEY;
  const provider = process.env.BENCH_AGENT_PROVIDER ?? "groq";
  if (!key || provider !== "groq") return;
  const model = process.env.BENCH_AGENT_MODEL ?? "openai/gpt-oss-20b";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (res?.status === 429) {
    const body = await res.text();
    if (/tokens per day|TPD/i.test(body)) throw new ProviderCapReached(`${model}: daily token cap reached`);
  }
}
