import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import type { CacheEntry, ModelProvider, ProviderModel } from "./types";
import { CACHE_TTL_MS, fetchProviderModels, requireApiKey } from "./types";

const MODELS_URL = "https://api.groq.com/openai/v1/models";
const ENV_VAR = "GROQ_API_KEY";

let cache: CacheEntry<ProviderModel[]> | null = null;

/**
 * Native `@ai-sdk/groq`, not the generic OpenAI-compat `baseURL` trick: structured outputs are
 * on by default with `strictJsonSchema` for guaranteed schema compliance, plus `reasoningFormat`/
 * `reasoningEffort`/`serviceTier` options the generic wrapper has no knowledge of. Model listing
 * still has no native-package equivalent, so that part stays a hand-rolled fetch against Groq's
 * own `/models` endpoint regardless.
 */
export const groqProvider: ModelProvider = {
  id: "groq",
  label: "Groq",
  envVar: ENV_VAR,
  languageModel(modelId: string): LanguageModel {
    const apiKey = requireApiKey(ENV_VAR);
    const groq = createGroq({ apiKey });
    return groq(modelId);
  },
  async listModels(): Promise<ProviderModel[]> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const models = await fetchProviderModels("Groq", MODELS_URL, process.env[ENV_VAR]);
    cache = { at: Date.now(), value: models };
    return models;
  },
};
