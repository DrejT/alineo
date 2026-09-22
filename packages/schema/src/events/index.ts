/**
 * Imports every event file for its side effect, so `allEvents()` is complete.
 *
 * The registry is populated by `defineEvent` at module load, which means a consumer that
 * reaches the registry without having loaded the definitions sees an empty one — and an empty
 * registry does not throw, it just quietly returns nothing. That bit once already: the
 * `@alineo-labs/schema/alineod` entry derives `AlineodEvent` from `allEvents()`, and splitting
 * it into its own bundle emptied `specs/alineod/events.schema.json` from 594 lines to one.
 *
 * Every entry point imports this, so all of them share one populated registry.
 */
export * as SandboxEvents from "./sandbox";
export * as AgentEvents from "./agent";
export * as HarnessEvents from "./harness";
export * as WorkflowEvents from "./workflow";
export * as AlineodEvents from "./alineod";
