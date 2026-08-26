export type { ResourceRef } from "./types";
export { scopeKey } from "./types";

export { MemoryCapabilityError } from "./errors";
export type { MemoryCapability } from "./errors";

export { InMemoryWorkingMemoryProvider } from "./working";
export type { IWorkingMemoryProvider } from "./working";

export { InMemorySemanticMemoryProvider, isPrunable, cosineSimilarity } from "./semantic";
export type {
  EmbeddingProvider,
  ISemanticMemoryProvider,
  IPrunableSemanticMemoryProvider,
  MemoryFact,
  RememberedFact,
} from "./semantic";

export { episodicRecall } from "./episodic";
export type { EpisodicRecallOptions, SandboxSessionRef } from "./episodic";

export { compactSemanticMemory } from "./compaction";
export type { CompactionOptions, CompactionResult } from "./compaction";

export { createMemoryLifecycleHooks } from "./lifecycle-hooks";
export type { MemoryLifecycleHooksOptions, LastCheckpointRecord } from "./lifecycle-hooks";

export { Memory } from "./memory";
export type { MemoryOptions } from "./memory";
