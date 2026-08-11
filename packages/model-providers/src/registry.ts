import { googleProvider } from "./google";
import { groqProvider } from "./groq";
import { nvidiaProvider } from "./nvidia";
import type { ModelProvider } from "./types";

export const MODEL_PROVIDERS: ModelProvider[] = [nvidiaProvider, googleProvider, groqProvider];

export function findModelProvider(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((p) => p.id === id);
}
