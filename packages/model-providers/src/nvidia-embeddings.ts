import { requireApiKey } from "./types";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const ENV_VAR = "NVIDIA_API_KEY";
const DEFAULT_MODEL = "nvidia/nv-embedqa-e5-v5";

/**
 * Shape any `EmbeddingProvider`-consuming package (`@alineo-labs/memory`'s
 * `ISemanticMemoryProvider` implementations, e.g.) expects — `{id, embed(texts)}`. Defined
 * locally rather than imported so this package never depends on `@alineo-labs/memory`;
 * structural typing means the return value of `createNvidiaEmbeddingProvider()` is assignable
 * anywhere an `EmbeddingProvider` is expected without either package knowing about the other.
 */
export interface NvidiaEmbeddingProvider {
  id: string;
  /** `opts.type` selects NIM's `input_type` for this specific call — `"passage"` when storing
   *  a fact, `"query"` when embedding a search string — overriding the constructor-time
   *  default below. Matches `@alineo-labs/memory`'s `EmbeddingProvider.embed()` shape exactly,
   *  so this is a drop-in `EmbeddingProvider` without either package depending on the other. */
  embed(texts: string[], opts?: { type?: "query" | "passage" }): Promise<number[][]>;
}

export interface NvidiaEmbeddingOptions {
  /** NIM embedding model ID. Defaults to `"nvidia/nv-embedqa-e5-v5"`. */
  model?: string;
  /**
   * NIM's embedding endpoint asks whether the text being embedded is a search query or a
   * stored passage — asymmetric embedding models (most NIM ones) rank better when this
   * matches how the text is actually used. This is only the *fallback* used when a given
   * `embed()` call doesn't specify its own `opts.type` (e.g. a caller using this provider
   * directly rather than through `@alineo-labs/memory`, which always passes `type` explicitly
   * on every `remember()`/`recall()` call). Defaults to `"query"`.
   */
  inputType?: "query" | "passage";
}

/**
 * NVIDIA NIM has no official AI SDK provider package (same situation `nvidiaProvider` in
 * `./nvidia.ts` already documents for chat completions) — this hand-rolls a raw fetch against
 * NIM's OpenAI-compatible `/v1/embeddings` endpoint rather than going through `@ai-sdk/openai`,
 * since the embeddings response only needs one field (`data[].embedding`) and pulling in the
 * AI SDK's embedding abstraction for that would be more machinery than the job needs.
 */
export function createNvidiaEmbeddingProvider(
  opts: NvidiaEmbeddingOptions = {},
): NvidiaEmbeddingProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const defaultInputType = opts.inputType ?? "query";
  return {
    id: `nvidia:${model}`,
    async embed(texts: string[], callOpts?: { type?: "query" | "passage" }): Promise<number[][]> {
      if (texts.length === 0) return [];
      const inputType = callOpts?.type ?? defaultInputType;
      const apiKey = requireApiKey(ENV_VAR);
      const res = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: texts, model, input_type: inputType }),
      });
      if (!res.ok) {
        throw new Error(
          `NVIDIA NIM embeddings request failed: ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      // NIM (like OpenAI) doesn't guarantee response order matches request order — sort by
      // the returned index rather than trusting array position.
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
