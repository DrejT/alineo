export { Alineo } from "./agent";
export type { AgentSpec, SetupStep } from "./schema";
export { validateAgentSpec } from "./schema";
export type {
  PermissionMode,
  PermissionAction,
  PermissionRule,
  PermissionPolicy,
} from "./permissions";
export type {
  AgentEvent,
  AgentStream,
  PermissionDecision,
  // eslint-disable-next-line typescript/no-deprecated -- deliberately still re-exported for backward compat until PromptStream's own removal
  PromptStream,
  PiModel,
  ThinkingLevel,
  PiMessage,
  CompactResult,
  SessionStats,
  PiSlashCommand,
  PiSessionState,
} from "./types";
export { textOnly } from "./types";
export type { AgentSnapshotRecord } from "./snapshots";
export { AgentSnapshotStore, computeSetupHash, snapshotsPath } from "./snapshots";
export { PromptTimeoutError, AgentSpecValidationError } from "./errors";
