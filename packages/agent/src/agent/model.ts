import type { PiModel, ThinkingLevel } from "../types";
import type { AgentInternal } from "./internal";
import { pi } from "./pi";

/** Set Pi's reasoning level (for models that support extended thinking). */
export async function setThinkingLevel(a: AgentInternal, level: ThinkingLevel): Promise<void> {
  return pi(a, "setThinkingLevel").setThinkingLevel(level);
}

/** Switch Pi to a specific model. Returns the activated model. */
export async function setModel(
  a: AgentInternal,
  provider: string,
  modelId: string,
): Promise<PiModel> {
  return pi(a, "setModel").setModel(provider, modelId);
}

/** Cycle Pi to the next available model. Returns null if only one model is configured. */
export async function cycleModel(a: AgentInternal): Promise<{
  model: PiModel;
  thinkingLevel: ThinkingLevel;
  isScoped: boolean;
} | null> {
  return pi(a, "cycleModel").cycleModel();
}

/** Cycle Pi's thinking level. Returns null if the current model doesn't support thinking. */
export async function cycleThinkingLevel(
  a: AgentInternal,
): Promise<{ level: ThinkingLevel } | null> {
  return pi(a, "cycleThinkingLevel").cycleThinkingLevel();
}

/** List all models available to Pi under the current provider configuration. */
export async function getAvailableModels(a: AgentInternal): Promise<PiModel[]> {
  return pi(a, "getAvailableModels").getAvailableModels();
}
