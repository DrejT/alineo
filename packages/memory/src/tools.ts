import type { Memory } from "./memory";
import type { ResourceRef } from "./types";

/**
 * A tool definition in the shape most agent-tool-calling conventions already expect: a name,
 * a description the model reads to decide when to call it, a JSON Schema for its arguments,
 * and an executor. Deliberately generic rather than typed against Pi's own RPC tool-call
 * protocol — `alineo`'s Pi bridge (`packages/agent/src/adapters/pi-bridge.js`) doesn't yet
 * expose a way to register caller-defined tools into a running Pi session, so wiring these
 * into an actual live agent is left to the caller (or a follow-up change to the bridge).
 * What this gives you today is the tool *definitions* ready to adapt into whatever surface —
 * Pi once it supports it, a different agent framework, or a manual dispatch loop.
 */
export interface MemoryTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Build the standard set of memory tools for one resource: working-memory get/set, and (only
 * when `memory.hasSemanticMemory`) remember/recall. This is what lets a *model*, not just the
 * surrounding application code, decide to persist or retrieve a fact mid-conversation — the
 * gap left by `Memory` being a plain TS API a developer must call explicitly.
 */
export function createMemoryTools(memory: Memory, ref: ResourceRef): MemoryTool[] {
  const tools: MemoryTool[] = [
    {
      name: "set_working_memory",
      description:
        "Store a structured fact about this resource in working memory, under a named key. Overwrites any existing value for that key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The fact's name, e.g. 'preferredLanguage'." },
          value: { description: "The value to store. Any JSON-serializable value." },
        },
        required: ["key", "value"],
      },
      async execute(args) {
        const key = String(args.key ?? "");
        await memory.workingMemory.set(ref, key, args.value);
        return { ok: true };
      },
    },
    {
      name: "get_working_memory",
      description: "Retrieve every structured working-memory fact stored for this resource.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return memory.workingMemory.list(ref);
      },
    },
  ];

  if (memory.hasSemanticMemory) {
    tools.push(
      {
        name: "remember_fact",
        description:
          "Store a fact in long-term semantic memory, for later recall by meaning rather than exact key. Use for things worth remembering across sessions.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The fact to remember, as plain text." },
          },
          required: ["content"],
        },
        async execute(args) {
          const content = String(args.content ?? "");
          await memory.remember(ref, { content });
          return { ok: true };
        },
      },
      {
        name: "recall_facts",
        description: "Search long-term semantic memory for facts relevant to a query.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            topK: { type: "number", description: "Max number of facts to return. Defaults to 5." },
          },
          required: ["query"],
        },
        async execute(args) {
          const query = String(args.query ?? "");
          const topK = typeof args.topK === "number" ? args.topK : undefined;
          const facts = await memory.recall(ref, query, { topK });
          return { facts: facts.map((f) => f.content) };
        },
      },
    );
  }

  return tools;
}
