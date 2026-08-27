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

export { episodicTree } from "./episodic-tree";
export type { EpisodicBranch, EpisodicTreeOptions } from "./episodic-tree";

export { compactSemanticMemory } from "./compaction";
export type { CompactionOptions, CompactionResult } from "./compaction";

export { createMemoryLifecycleHooks } from "./lifecycle-hooks";
export type { MemoryLifecycleHooksOptions, LastCheckpointRecord } from "./lifecycle-hooks";

export { SchemaWorkingMemory } from "./schema-working-memory";
export type { SchemaValidator } from "./schema-working-memory";

export { createMemoryTools } from "./tools";
export type { MemoryTool } from "./tools";

export { buildContextSnippet } from "./pipeline";
export type { ContextSnippetOptions } from "./pipeline";

export {
  MemoryAccessDeniedError,
  withTeamAccessControl,
  withTeamAccessControlSemantic,
} from "./access-control";
export type { TeamAccessChecker } from "./access-control";

export { Memory } from "./memory";
export type { MemoryOptions, AutoCompactOptions, ForkMemoryResult } from "./memory";
