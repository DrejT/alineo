/**
 * The agent SDK's own events — what `alineo` adds on top of a sandbox.
 *
 * Started as two, both from the human-in-the-loop permission gate; `AgentCheckpointed`
 * (durability-roadmap M3, 3.2) is the third. All three live in `packages/core`'s ledger enum
 * too, under a "used by the `alineo` agent SDK" heading, which is exactly the layering
 * inversion this package fixes: `core` knows nothing about agents. Not resolved here —
 * `sb.emit()` is typed to `packages/core`'s `LedgerEvent` enum, so a new agent-SDK event still
 * needs a member there to be emittable at all; this file is the vocabulary-check and
 * documentation registry for the same type string, not a replacement for it yet.
 */
import { z } from "zod";
import { defineEvent } from "../define";

export const PermissionRequested = defineEvent({
  type: "permission.requested",
  durable: true,
  version: 1,
  description:
    "The permission gate paused a tool call for human approval. Metadata only — raw tool " +
    "arguments can carry secrets in a bash command or a file write, and are never recorded.",
  schema: z.object({
    requestId: z.string(),
    tool: z.string(),
    target: z.string(),
    title: z.string().optional(),
  }),
});

export const PermissionResolved = defineEvent({
  type: "permission.resolved",
  durable: true,
  version: 1,
  description:
    "A permission request was answered — by a caller, a batched always/reject decision, a " +
    "timeout, or a session resume dropping it.",
  schema: z.object({ requestId: z.string(), decision: z.string() }),
});

export const AgentCheckpointed = defineEvent({
  type: "agent.checkpointed",
  durable: true,
  version: 1,
  description:
    "A turn-level checkpoint (workspace + session-file tarball) was captured and durably " +
    "stored, after the tarball itself was confirmed written — a snapshot with no event " +
    "pointing at it is unreachable garbage.",
  schema: z.object({ turn: z.number(), snapshotRef: z.string() }),
});
