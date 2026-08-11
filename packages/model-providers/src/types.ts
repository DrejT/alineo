import type { LanguageModel } from "ai";

export interface ProviderModel {
  id: string;
}

/**
 * One model provider this dashboard can reach — owns its own credential env var, its AI SDK
 * `LanguageModel` construction, and its own model-catalog fetch. No AI SDK provider package
 * (native or generic) exposes catalog listing for any provider, so every provider module hand-
 * rolls that one piece the same way even though `languageModel()` itself is a thin wrapper.
 */
export interface ModelProvider {
  id: string;
  label: string;
  envVar: string;
  /** Throws if `envVar` isn't set in process.env. */
  languageModel(modelId: string): LanguageModel;
  /** Never throws — returns [] and logs on a missing key or a failed request, so one provider's
   * outage/missing key doesn't break the picker for the others. */
  listModels(): Promise<ProviderModel[]>;
}

export function requireApiKey(envVar: string): string {
  const key = process.env[envVar];
  if (!key) throw new Error(`${envVar} is not set on the dashboard server`);
  return key;
}

export interface CacheEntry<T> {
  at: number;
  value: T;
}

export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Shared model-list fetch behind every provider's `listModels()`: bearer-auth GET against
 * `{baseURL}{modelsPath}`, expecting `{ data: ProviderModel[] }` — the shape every provider
 * targeted here (NVIDIA NIM, Gemini's OpenAI-compat endpoint, Groq) already returns. Never
 * throws; a missing key or failed request logs and returns `[]` so one provider's outage doesn't
 * break the picker for the others. */
export async function fetchProviderModels(
  label: string,
  url: string,
  apiKey: string | undefined,
): Promise<ProviderModel[]> {
  if (!apiKey) return [];
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    console.error(
      `${label} models request failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
    return [];
  }
  const data = (await res.json()) as { data: ProviderModel[] };
  return data.data;
}
