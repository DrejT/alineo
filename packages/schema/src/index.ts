// Vocabulary — the words every surface derives its names from.
export { SUBJECTS, VERBS, isSubject, isVerb, parseName } from "./vocabulary";
export type { Subject, Verb } from "./vocabulary";

// The envelope — one record shape for an event from any layer.
export { isPersisted } from "./envelope";
export type { DurableRef, EventRef, LedgerEnvelope, PersistedEnvelope } from "./envelope";

// Event definitions, and the registry they populate.
export { allEvents, defineEvent, durableEvents, getEvent } from "./define";
export type { EnvelopeOf, EventData, EventDefinition } from "./define";

// Importing every event file is what fills the registry. A consumer that only wants one
// namespace still gets a complete `allEvents()`, which is what the conformance check and the
// drift guards read.
export * from "./events";

export type {
  NormalizedPermissionPolicy,
  PermissionAction,
  PermissionMode,
  PermissionPolicy,
  PermissionRule,
} from "./permissions";

export { AgentSpecSchema } from "./agent-spec";
export type { AgentSpec, CredentialEnvBinding, SetupStep } from "./agent-spec";

export {
  PROJECT_CONFIG_SCHEMA_URL,
  ProjectConfigObjectSchema,
  ProjectConfigSchema,
} from "./project";
export type { ProjectConfig } from "./project";

export { RENAMED_EVENTS, renamedEventType } from "./renames";
