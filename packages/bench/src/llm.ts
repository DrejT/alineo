/**
 * Judge model providers. Keys are read from the environment at call time and are never logged, cached
 * or written into results. Every call goes through one retry/backoff path, a hard call budget, and an
 * on-disk cache keyed by (provider, prompt, schema) so a crashed run can resume without repeating work.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JsonSchema = Record<string, unknown>;

export class BudgetExceeded extends Error {
  constructor(public readonly limit: number) {
    super(`judge call budget of ${limit} exhausted`);
  }
}

export interface CompleteOptions {
  /** Skip the cache for this call (used when measuring run-to-run variation). */
  fresh?: boolean;
}

export interface LlmProvider {
  /** Stable id recorded in every result, e.g. "groq:qwen/qwen3.8-27b". */
  id: string;
  /** Model family, used to detect self-preference (judge family == author family). */
  family: "qwen" | "gptoss" | "gemini" | "other";
  model: string;
  complete(prompt: string, schema: JsonSchema, opts?: CompleteOptions): Promise<unknown>;
}

const CACHE_PATH = () => process.env.BENCH_JUDGE_CACHE ?? "results/.judge-cache.json";
let cache: Record<string, unknown> | undefined;

function cacheGet(k: string): unknown {
  cache ??= existsSync(CACHE_PATH()) ? JSON.parse(readFileSync(CACHE_PATH(), "utf8")) : {};
  return cache![k];
}

function cacheSet(k: string, v: unknown): void {
  cache![k] = v;
  mkdirSync(dirname(CACHE_PATH()), { recursive: true });
  writeFileSync(CACHE_PATH(), JSON.stringify(cache));
}

let budgetLimit = Number(process.env.BENCH_JUDGE_MAX_CALLS ?? 600);
let uncachedCalls = 0;

export function setBudget(limit: number): void {
  budgetLimit = limit;
  uncachedCalls = 0;
}

export function callsMade(): number {
  return uncachedCalls;
}

/** Retries 429/5xx with exponential backoff (honouring Retry-After). Throws a message free of secrets. */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // A reused keep-alive connection that the server has closed makes Bun's fetch hang until the
        // timeout, so ask for a fresh connection each time and retry quickly if one still stalls.
        headers: { "content-type": "application/json", connection: "close", ...headers },
        keepalive: false,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.BENCH_JUDGE_TIMEOUT_MS ?? 60_000)),
      });
    } catch (e) {
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`request to ${new URL(url).host} failed after retries: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 7) {
      const hinted = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 3000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(60_000, wait)));
      continue;
    }
    const text = (await res.text()).slice(0, 240);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text}`);
  }
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`model did not return JSON: ${text.slice(0, 120)}`);
  }
}

function cached(id: string, run: LlmProvider["complete"]): LlmProvider["complete"] {
  return async (prompt, schema, opts) => {
    const key = createHash("sha256").update(id).update("\0").update(prompt).update("\0").update(JSON.stringify(schema)).digest("hex");
    const hit = cacheGet(key); // also loads the cache file, so a later write never drops old entries
    if (!opts?.fresh && hit !== undefined) return hit;
    if (uncachedCalls >= budgetLimit) throw new BudgetExceeded(budgetLimit);
    uncachedCalls++;
    const t0 = Date.now();
    const n = uncachedCalls;
    const out = await run(prompt, schema, opts);
    if (process.env.BENCH_JUDGE_VERBOSE) console.error(`[judge] #${n} ${id} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    cacheSet(key, out);
    return out;
  };
}

/**
 * Sliding-window token limiter. Groq's free tier allows 8,000 tokens per minute for this model (and 1,000
 * requests per day), and a judge prompt is a couple of thousand tokens, so unthrottled parallel calls just
 * produce 429s. Token counts are estimated (~3.5 characters per token) plus room for the reply.
 */
export class TokenLimiter {
  private events: { at: number; tokens: number }[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly perMinute: number) {}

  /** Serialized so concurrent callers queue instead of all waking at once. */
  acquire(tokens: number): Promise<void> {
    const run = this.chain.then(async () => {
      const need = Math.min(tokens, this.perMinute);
      for (;;) {
        const now = Date.now();
        this.events = this.events.filter((e) => now - e.at < 60_000);
        const used = this.events.reduce((a, e) => a + e.tokens, 0);
        if (used + need <= this.perMinute) break;
        const oldest = this.events[0]!;
        await new Promise((r) => setTimeout(r, Math.max(250, 60_000 - (now - oldest.at) + 50)));
      }
      this.events.push({ at: Date.now(), tokens: need });
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export const estimateTokens = (prompt: string, reply = 450) => Math.ceil(prompt.length / 3.5) + reply;

/** Groq limits tokens per model, so each model gets its own window. */
const groqLimiters = new Map<string, TokenLimiter>();
const groqLimiter = (model: string) => {
  let l = groqLimiters.get(model);
  if (!l) groqLimiters.set(model, (l = new TokenLimiter(Number(process.env.BENCH_GROQ_TPM ?? 7000))));
  return l;
};

export const QWEN_MODEL = "qwen/qwen3.8-27b";
export const GPTOSS_JUDGE_MODEL = "openai/gpt-oss-120b";
export const GPTOSS_AUTHOR_MODEL = "openai/gpt-oss-20b";

const groqFamily = (model: string): LlmProvider["family"] =>
  model.includes("qwen") ? "qwen" : model.includes("gpt-oss") ? "gptoss" : "other";

/** Groq's OpenAI-compatible endpoint, strict JSON-schema output. */
export function groqProvider(model = process.env.BENCH_GROQ_MODEL ?? QWEN_MODEL): LlmProvider {
  const id = `groq:${model}`;
  return {
    id,
    family: groqFamily(model),
    model,
    complete: cached(id, async (prompt, schema) => {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error("set GROQ_API_KEY for the Groq judge");
      // gpt-oss is a reasoning model: its hidden reasoning counts against Groq's token limit, so budget far more per reply.
      const tAcquire = Date.now();
      await groqLimiter(model).acquire(estimateTokens(prompt, model.includes("gpt-oss") ? 2400 : 450));
      if (process.env.BENCH_JUDGE_VERBOSE) {
        console.error(`[judge] ${id} limiter wait ${((Date.now() - tAcquire) / 1000).toFixed(1)}s, est ${estimateTokens(prompt)} tokens`);
      }
      const body = (await postJson(
        "https://api.groq.com/openai/v1/chat/completions",
        { authorization: `Bearer ${key}` },
        {
          model,
          temperature: 0,
          // Bound the reply: a reasoning model with no cap can think for minutes on one verdict.
          max_tokens: Number(process.env.BENCH_GROQ_MAX_TOKENS ?? 3500),
          ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_schema", json_schema: { name: "judgement", strict: true, schema } },
        },
      )) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { completion_tokens?: number } };
      if (process.env.BENCH_JUDGE_VERBOSE) {
        console.error(`[judge] ${id} completion_tokens=${body.usage?.completion_tokens} finish=${body.choices?.[0]?.finish_reason}`);
      }
      return parseJsonLoose(body.choices?.[0]?.message?.content ?? "");
    }),
  };
}

/** Gemini wants upper-case type names and no additionalProperties. */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (k === "additionalProperties") continue;
      out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v);
    }
    return out;
  }
  return s;
}

export function geminiProvider(model = process.env.BENCH_GEMINI_MODEL ?? "gemini-flash-lite-latest"): LlmProvider {
  const id = `gemini:${model}`;
  return {
    id,
    family: "gemini",
    model,
    complete: cached(id, async (prompt, schema) => {
      const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!key) throw new Error("set GEMINI_API_KEY or GOOGLE_API_KEY for the Gemini judge");
      const body = (await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { "x-goog-api-key": key },
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(schema),
          },
        },
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return parseJsonLoose(text);
    }),
  };
}

/** Free-form Gemini text (the other author in the self-preference test). */
export async function geminiText(
  prompt: string,
  model = process.env.BENCH_GEMINI_MODEL ?? "gemini-flash-lite-latest",
): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("set GEMINI_API_KEY or GOOGLE_API_KEY for the Gemini judge");
  if (uncachedCalls >= budgetLimit) throw new BudgetExceeded(budgetLimit);
  uncachedCalls++;
  const body = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": key },
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } },
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
}

/** Free-form text generation (used to have a second model family write a candidate answer). */
export async function groqText(prompt: string, model = process.env.BENCH_GROQ_MODEL ?? QWEN_MODEL): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("set GROQ_API_KEY for the Groq judge");
  if (uncachedCalls >= budgetLimit) throw new BudgetExceeded(budgetLimit);
  uncachedCalls++;
  await groqLimiter(model).acquire(estimateTokens(prompt, model.includes("gpt-oss") ? 1500 : 250));
  const body = (await postJson(
    "https://api.groq.com/openai/v1/chat/completions",
    { authorization: `Bearer ${key}` },
    { model, temperature: 0, messages: [{ role: "user", content: prompt }] },
  )) as { choices?: { message?: { content?: string } }[] };
  return (body.choices?.[0]?.message?.content ?? "").trim();
}
