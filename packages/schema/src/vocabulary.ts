/**
 * The two lists every alineo surface derives its names from.
 *
 * One user meets the CLI, the SDK, the daemon's HTTP API, the MCP tools and the event
 * stream. Each of those is free to pick its own spelling, and historically each did — which
 * is how `spawn` came to mean "create a root agent" in the CLI and "create a child" in the
 * SDK, and how `fork` came to mean three different operations.
 *
 * Making the vocabulary *data* is what lets CI fail a name rather than a reviewer catch it.
 * The checks that consume these lists land with the surfaces they police (CLI and help
 * strings, MCP tools and HTTP routes, event types); this module is only the source of truth.
 */

/**
 * The things alineo acts on. A name's first segment is one of these.
 *
 * Ordered by layer rather than alphabetically — control plane, then the agent loop, then the
 * substrate, then the operator-facing objects — because that is how the surfaces group.
 *
 * `event`, `result` and `transcript` are the records a run leaves behind. They joined the list
 * when the HTTP and MCP checks landed and found them already on the wire
 * (`GET /agents/:id/transcript`, `GET /runs/:id/events`): they were vocabulary in use, just not
 * written down.
 */
export const SUBJECTS = [
  "run",
  "agent",
  "sandbox",
  "session",
  "turn",
  "message",
  "tool",
  "handle",
  "wait",
  "inbox",
  "notify",
  "budget",
  "exec",
  "egress",
  "credential",
  "permission",
  "workflow",
  "step",
  "compaction",
  "retry",
  "extension",
  "queue",
  "spec",
  "environment",
  "event",
  "result",
  "transcript",
] as const;

/**
 * What alineo does to a subject. A name's second segment is one of these — in the imperative
 * for a command, method, route or tool, and in the past tense for an event (`agent.spawned`).
 *
 * `branchSession` and `duplicateSession` are camelCase because they exist only as SDK
 * methods; no route, tool or event uses them. They carry `Session` in the name on purpose:
 * unqualified `branch`/`duplicate` read like sandbox operations, and they are not — both stay
 * inside one container and only touch the harness conversation.
 */
export const VERBS = [
  "start",
  "spawn",
  "stop",
  "pause",
  "resume",
  "reattach",
  "attach",
  "prompt",
  "steer",
  "await",
  "checkpoint",
  "fork",
  "branchSession",
  "duplicateSession",
  "add",
  "list",
  "remove",
  "get",
  "watch",
  "init",
  "deliver",
] as const;

export type Subject = (typeof SUBJECTS)[number];
export type Verb = (typeof VERBS)[number];

const SUBJECT_SET: ReadonlySet<string> = new Set(SUBJECTS);
const VERB_SET: ReadonlySet<string> = new Set(VERBS);

export function isSubject(value: string): value is Subject {
  return SUBJECT_SET.has(value);
}

export function isVerb(value: string): value is Verb {
  return VERB_SET.has(value);
}

/**
 * Split a two-segment name into its subject and verb, or return `null` if either half is not
 * in the lists above.
 *
 * The separator is what distinguishes the surfaces: `_` for an MCP tool (`agent_spawn`), `.`
 * for an event type (`agent.spawned`). Only the first separator splits, so a multi-word verb
 * stays intact.
 *
 * Note for the event check (Track 1): event verbs are past tense and so will not be in
 * `VERBS` literally — `agent.spawned`, not `agent.spawn`. That check needs its own tense
 * rule on top of `isSubject`; this helper is exact-match only.
 */
export function parseName(
  name: string,
  separator: "_" | ".",
): { subject: Subject; verb: Verb } | null {
  const at = name.indexOf(separator);
  if (at <= 0) return null;
  const subject = name.slice(0, at);
  const verb = name.slice(at + separator.length);
  if (!isSubject(subject) || !isVerb(verb)) return null;
  return { subject, verb };
}
