import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { CacheEntry, ModelProvider, ProviderModel } from "./types";
import { CACHE_TTL_MS, fetchProviderModels, requireApiKey } from "./types";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const ENV_VAR = "NVIDIA_API_KEY";

let cache: CacheEntry<ProviderModel[]> | null = null;

/**
 * NVIDIA NIM has no official AI SDK provider package — it's a third-party inference host, not a
 * Vercel AI SDK partner. `@ai-sdk/openai`'s `createOpenAI({baseURL})` generic OpenAI-compat trick
 * is the right (and only) tool here — NIM exposes an OpenAI-compatible chat completions endpoint.
 */
export const nvidiaProvider: ModelProvider = {
  id: "nvidia",
  label: "NVIDIA NIM",
  envVar: ENV_VAR,
  languageModel(modelId: string): LanguageModel {
    const apiKey = requireApiKey(ENV_VAR);
    return createOpenAI({ apiKey, baseURL: BASE_URL }).chat(modelId);
  },
  async listModels(): Promise<ProviderModel[]> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const models = await fetchProviderModels(
      "NVIDIA NIM",
      `${BASE_URL}/models`,
      process.env[ENV_VAR],
    );
    cache = { at: Date.now(), value: models };
    return models;
  },
};
