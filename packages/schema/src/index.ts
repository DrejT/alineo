// Vocabulary — the words every surface derives its names from.
export { SUBJECTS, VERBS, isSubject, isVerb, parseName } from "./vocabulary";
export type { Subject, Verb } from "./vocabulary";

// The envelope — one record shape for an event from any layer.
export { isPersisted } from "./envelope";
export type { DurableRef, EventRef, LedgerEnvelope, PersistedEnvelope } from "./envelope";

// Event definitions, and the registry they populate.
export { allEvents, defineEvent, durableEvents, getEvent } from "./define";
export type { EnvelopeOf, EventData, EventDefinition } from "./define";

// Importing each file for its side effect is what fills the registry. A consumer that only
// wants one namespace still gets a complete `allEvents()`, which is what the conformance
// check and the drift guards read.
export * as SandboxEvents from "./events/sandbox";
export * as AgentEvents from "./events/agent";
export * as HarnessEvents from "./events/harness";
export * as WorkflowEvents from "./events/workflow";
export * as AlineodEvents from "./events/alineod";

export { RENAMED_EVENTS, renamedEventType } from "./renames";
