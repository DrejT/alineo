import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { CacheEntry, ModelProvider, ProviderModel } from "./types";
import { CACHE_TTL_MS, fetchProviderModels, requireApiKey } from "./types";

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/openai/models";
const ENV_VAR = "GEMINI_API_KEY";

let cache: CacheEntry<ProviderModel[]> | null = null;

/**
 * Native `@ai-sdk/google`, not the generic OpenAI-compat `baseURL` trick: Gemini's OpenAI-compat
 * shim maps onto a subset of OpenAPI 3.0 schema that doesn't support unions/records, which risks
 * exactly the class of structured-output failure this package exists to avoid. The native
 * package also gets `safetySettings`/`thinkingConfig`/grounding tools for free if this ever
 * needs them later.
 * Model listing still has no native-package equivalent, so that part stays a hand-rolled fetch
 * against Gemini's OpenAI-compat `/models` endpoint regardless.
 */
export const googleProvider: ModelProvider = {
  id: "google",
  label: "Google (Gemini)",
  envVar: ENV_VAR,
  languageModel(modelId: string): LanguageModel {
    const apiKey = requireApiKey(ENV_VAR);
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelId);
  },
  async listModels(): Promise<ProviderModel[]> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const models = await fetchProviderModels("Gemini", MODELS_URL, process.env[ENV_VAR]);
    cache = { at: Date.now(), value: models };
    return models;
  },
};
