/**
 * The type-only entry point: `@alineo-labs/schema/types`.
 *
 * Exists so a package with no validator dependency — `@alineo-labs/core` has exactly one
 * workspace dep and wants to keep it that way — can take the envelope's shape under
 * `import type` and have it erase entirely at compile time. Everything here is a type; there
 * is deliberately no runtime value in this file's graph.
 */
export type { DurableRef, EventRef, LedgerEnvelope, PersistedEnvelope } from "./envelope";
export type { Subject, Verb } from "./vocabulary";
export type {
  NormalizedPermissionPolicy,
  PermissionAction,
  PermissionMode,
  PermissionPolicy,
  PermissionRule,
} from "./permissions";
export type { AgentSpec, CredentialEnvBinding, SetupStep } from "./agent-spec";
