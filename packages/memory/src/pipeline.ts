import type { Memory } from "./memory";
import type { ResourceRef } from "./types";

export interface ContextSnippetOptions {
  /** Run semantic recall against this query and fold the results in. Omit to skip semantic
   *  recall entirely (e.g. no semantic provider configured, or nothing relevant to search for
   *  yet — a fresh session with no user message). */
  query?: string;
  /** Max facts to pull from semantic recall. Passed through to `Memory.recall()`. */
  topK?: number;
  /** Cap how many working-memory keys are included, in case a resource has accumulated many. */
  maxWorkingMemoryKeys?: number;
}

/**
 * Assemble a plain-text context block from a resource's working + semantic memory — the
 * "inject relevant memory into the prompt on session start" half of owning the memory
 * pipeline, previously entirely missing (the package shipped only the primitives an app had
 * to remember to call). Returns `""` if there's nothing to say (fresh resource, no query).
 *
 * This builds the string; it does not inject it anywhere on its own — `alineo`'s Pi bridge has
 * no hook today for prepending to a session's system prompt, so wiring the result of this into
 * an actual agent conversation is left to the caller (e.g. prepend it to the first `prompt()`
 * call, or fold it into `AgentSpec.env`/setup for now).
 *
 * @example
 * ```ts
 * const context = await buildContextSnippet(memory, agent.resourceRef, { query: userMessage });
 * for await (const chunk of agent.prompt(context ? `${context}\n\n${userMessage}` : userMessage)) { ... }
 * ```
 */
export async function buildContextSnippet(
  memory: Memory,
  ref: ResourceRef,
  opts: ContextSnippetOptions = {},
): Promise<string> {
  const sections: string[] = [];

  const working = await memory.workingMemory.list(ref);
  const keys = Object.keys(working).slice(0, opts.maxWorkingMemoryKeys ?? 20);
  if (keys.length > 0) {
    sections.push(
      `Known facts about this resource:\n${keys
        .map((k) => `- ${k}: ${JSON.stringify(working[k])}`)
        .join("\n")}`,
    );
  }

  if (opts.query && memory.hasSemanticMemory) {
    const facts = await memory.recall(ref, opts.query, { topK: opts.topK });
    if (facts.length > 0) {
      sections.push(`Relevant memories:\n${facts.map((f) => `- ${f.content}`).join("\n")}`);
    }
  }

  return sections.join("\n\n");
}
