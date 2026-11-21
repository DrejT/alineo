/**
 * Model names the dashboard shows, and the models that actually run behind them.
 *
 * The UI only ever shows the Gemini names. Every agent turn runs on an NVIDIA NIM model.
 * The backend ids stay on the server: no route returns them, and `scrub()` rewrites them
 * if a model repeats its own name in a reply.
 *
 * Each backend was measured through a real Pi turn in a sandbox (apps/alineod/scripts/probe-models.ts),
 * and with 12 parallel requests, because a swarm runs several agents at once. Re-measure before
 * changing one. Rejected on 2026-11-21:
 *   - minimaxai/minimax-m3.1-flash         fast alone, but answers 429 to 11 of 12 parallel requests
 *   - mistralai/mistral-large-4-1t-a52b    429 on some parallel requests, 7 to 26 seconds on the rest
 *   - stepfun-ai/step-5-preview            hangs under parallel load
 *   - nvidia/nemotron-3.5-super-vl-120b-a12b empty turns in Pi
 *   - nvidia/nemotron-3-super-120b-a12b   410 Gone
 *   - nvidia/nemotron-3.5-bolt-e4b         empty turns
 *   - nvidia/nemotron-3.5-lightning-30b-a3b empty text, very slow
 *   - moonshotai/kimi-k3.1-pro, z-ai/glm-5.3-flash, google/gemma-4-31b-it   timed out
 */
export interface ModelOption {
  /** What the UI and API call the model. */
  id: string;
  label: string;
  /** NVIDIA NIM model id. Server only. */
  backend: string;
}

export const MODELS: readonly ModelOption[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", backend: "poolside/laguna-xs-2.1" },
  { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", backend: "nvidia/nemotron-3-ultra-550b-a55b" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash Medium", backend: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
];

export const DEFAULT_MODEL = MODELS[0]!;

/** Map any stored or requested value to a known Gemini option. Unknown values become the default. */
export function resolveModel(value: string | null | undefined): ModelOption {
  return MODELS.find((m) => m.id === value) ?? DEFAULT_MODEL;
}

/** Safe to return from the API: no backend ids. */
export function publicModels(): Array<{ id: string; label: string }> {
  return MODELS.map(({ id, label }) => ({ id, label }));
}

/** Replace backend model names in text with the Gemini label the user chose. */
export function scrub(text: string, model: ModelOption): string {
  let out = text;
  for (const m of MODELS) {
    const short = m.backend.split("/")[1]!;
    out = out.split(m.backend).join(model.label).split(short).join(model.label);
  }
  return out;
}
