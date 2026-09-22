/**
 * The agent SDK's own events — what `alineo` adds on top of a sandbox.
 *
 * Only two today, both from the human-in-the-loop permission gate. They lived in
 * `packages/core`'s ledger enum under a "used by the `alineo` agent SDK" heading, which is
 * exactly the layering inversion this package fixes: `core` knows nothing about agents.
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
