/**
 * Substrate events — the sandbox itself, and what runs inside it.
 *
 * Owned by `@alineo-labs/core`, which emits every one of them through the single funnel at
 * `sandbox/core.ts`'s `emit()` plus five `SandboxCreated` sites in the SDK client.
 *
 * These were declared in `packages/core/src/ledger.ts`, in one enum alongside the agent and
 * workflow layers' events — the bottom layer defining the vocabulary of two layers above it.
 * That is the coupling this package exists to break.
 */
import { z } from "zod";
import { defineEvent } from "../define";

export const SandboxCreated = defineEvent({
  type: "sandbox.created",
  durable: true,
  version: 1,
  description: "A sandbox reached Running state.",
  schema: z.object({
    sandboxId: z.string(),
    name: z.string(),
    runId: z.string(),
    resourceId: z.string().optional(),
    teamId: z.string().optional(),
    /** Set when this session came from `sb.fork()`; absent for a top-level `client.sandbox()`. */
    parentSandboxId: z.string().optional(),
  }),
});

export const SandboxClosed = defineEvent({
  type: "sandbox.closed",
  durable: true,
  version: 1,
  description: "A sandbox was closed and its container released.",
  schema: z.object({ sandboxId: z.string() }),
});

export const SandboxPaused = defineEvent({
  type: "sandbox.paused",
  durable: true,
  version: 1,
  description: "pause() froze the container.",
  schema: z.object({ sandboxId: z.string() }),
});

export const SandboxResumed = defineEvent({
  type: "sandbox.resumed",
  durable: true,
  version: 1,
  description: "resume() restored a frozen container to Running.",
  schema: z.object({ sandboxId: z.string() }),
});

export const SandboxCheckpointCreated = defineEvent({
  type: "sandbox.checkpoint_created",
  durable: true,
  version: 1,
  description: "checkpoint() captured a snapshot.",
  schema: z.object({ snapshotId: z.string(), tag: z.string().optional() }),
});

export const ExecStarted = defineEvent({
  type: "exec.started",
  durable: true,
  version: 1,
  description: "An exec() or execCode() call began.",
  schema: z.object({ command: z.string().optional(), code: z.string().optional() }),
});

export const ExecOutput = defineEvent({
  type: "exec.output",
  // The one high-volume substrate event: one per output chunk, and `exec.completed` carries
  // the full text anyway. Streamed, not stored.
  durable: false,
  version: 1,
  description: "A streaming output chunk from a running exec.",
  schema: z.object({ stream: z.enum(["stdout", "stderr"]).optional(), text: z.string() }),
});

export const ExecCompleted = defineEvent({
  type: "exec.completed",
  durable: true,
  version: 1,
  description: "An exec() or execCode() call finished.",
  schema: z.object({
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
});

export const EgressRuleAdded = defineEvent({
  type: "egress.rule_added",
  durable: true,
  version: 1,
  description:
    "sb.egress.patch() — the exact rules handed to the sidecar, so a resume can fold a " +
    "still-wanted allowance back into the new boot policy.",
  schema: z.object({ rules: z.array(z.unknown()) }),
});

export const EgressRuleRemoved = defineEvent({
  type: "egress.rule_removed",
  durable: true,
  version: 1,
  description: "sb.egress.delete().",
  schema: z.object({ targets: z.array(z.string()) }),
});

export const CredentialBound = defineEvent({
  type: "credential.bound",
  durable: true,
  version: 1,
  description:
    "sb.credentials.set()/.patch(). Binding metadata only — the credential value is never " +
    "written to the ledger.",
  schema: z.object({
    name: z.string(),
    host: z.string().optional(),
    injection: z.string().optional(),
  }),
});

export const CredentialRevoked = defineEvent({
  type: "credential.revoked",
  durable: true,
  version: 1,
  description: "sb.credentials.remove().",
  schema: z.object({ name: z.string() }),
});
