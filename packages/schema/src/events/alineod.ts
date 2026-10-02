/**
 * Swarm control-plane events — the run tree, its budgets, and how agents coordinate.
 *
 * Every one of these is durable. alineod's projections are rebuilt by folding them
 * (`state/projection.ts`'s `rebuild()`), so an event that is not written is state that does
 * not survive a restart — which is the whole basis of the daemon's crash-only design.
 *
 * Namespaced by subject rather than by the daemon that emits them: a user reads one mixed
 * stream and needs to know what an event is *about*. `agent.spawned`, not
 * `alineod.agent_spawned`.
 */
import { z } from "zod";
import { defineEvent } from "../define";

const WaitMode = z.enum(["all", "any", "quorum"]);

export const RunStarted = defineEvent({
  type: "run.started",
  durable: true,
  version: 1,
  description: "A swarm run was created. Was `run_started` — the name workflow also used.",
  schema: z.object({ runId: z.string() }),
});

export const RunQuiescent = defineEvent({
  type: "run.quiescent",
  durable: true,
  version: 1,
  description:
    "The subtree rooted at this agent went quiescent. Only tracked while someone is " +
    "awaiting it. Was `subtree_quiescent`.",
  schema: z.object({
    agentId: z.string().nullable(),
    memberCount: z.number().int(),
    asOf: z.number(),
  }),
});

export const AgentSpawned = defineEvent({
  type: "agent.spawned",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    parentAgentId: z.string().nullable(),
    runId: z.string(),
    specName: z.string(),
    depth: z.number().int(),
    spawnIndex: z.number().int(),
    sandboxId: z.string().nullable(),
    waitFor: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Persisted rather than left in the spec, so rehydrate() can retry a still-pending " +
          "spawn instead of losing it.",
      ),
    prompt: z.string().nullable().optional(),
  }),
});

export const AgentProvisioned = defineEvent({
  type: "agent.provisioned",
  durable: true,
  version: 1,
  description:
    "The sandbox exists and the bridge is up — backfills what `agent.spawned` could not know yet.",
  schema: z.object({ agentId: z.string().nullable(), sandboxId: z.string() }),
});

export const AgentStateChanged = defineEvent({
  type: "agent.state_changed",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
    pausedBy: z
      .enum(["operator", "cascade"])
      .optional()
      .describe(
        "On a transition to paused: whether this agent was the target, or was reached by a " +
          "subtree pause.",
      ),
  }),
});

export const AgentSteered = defineEvent({
  type: "agent.steered",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    message: z.string(),
    scope: z.enum(["agent", "subtree"]).optional(),
    roster: z.array(z.string()).optional(),
    deliveredAs: z.enum(["steer", "turn", "queued"]).optional(),
  }),
});

export const AgentReleased = defineEvent({
  type: "agent.released",
  durable: true,
  version: 1,
  description:
    "A finished agent's still-open sandbox was closed, or a fork landed after its spawn was " +
    "stopped. The recorded outcome is unchanged.",
  schema: z.object({ agentId: z.string().nullable(), reason: z.string() }),
});

export const AgentEnded = defineEvent({
  type: "agent.ended",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    outcome: z.string(),
    endedAt: z.number(),
    error: z.string().optional(),
  }),
});

export const HandleSettled = defineEvent({
  type: "handle.settled",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    outcome: z.string(),
    resultRef: z.string().nullable(),
  }),
});

export const WaitResolved = defineEvent({
  type: "wait.resolved",
  durable: true,
  version: 1,
  description:
    "A held spawn's waitFor resolved. A depfail or deadline outcome ends the child failed, " +
    "without ever forking it.",
  schema: z.object({
    agentId: z.string().nullable(),
    mode: WaitMode,
    outcome: z.enum(["satisfied", "partial", "deadline", "depfail"]),
    selected: z.array(z.string()),
    settled: z.array(z.object({ agentId: z.string(), outcome: z.string().nullable() })),
    pending: z.array(z.string()),
  }),
});

export const WaitBlocked = defineEvent({
  type: "wait.blocked",
  durable: true,
  version: 1,
  description:
    "A held spawn is waiting on a paused dependency — one event per dependency. Was " +
    "`wait_blocked_on_paused`.",
  schema: z.object({ agentId: z.string().nullable(), blockedOn: z.string() }),
});

export const NotifyRegistered = defineEvent({
  type: "notify.registered",
  durable: true,
  version: 1,
  description: "This agent asked to be told when each agent in `on` finishes.",
  schema: z.object({
    agentId: z.string().nullable(),
    on: z.array(z.string()),
    wake: z.boolean(),
  }),
});

export const InboxQueued = defineEvent({
  type: "inbox.queued",
  durable: true,
  version: 1,
  description:
    "Something for this agent to be told — a notification, a steer waiting for it to resume, " +
    "or a child needing a supervision decision.",
  schema: z.object({
    agentId: z.string().nullable(),
    kind: z.enum(["notification", "steer", "supervision"]),
    aboutAgentId: z.string().nullable().optional(),
    aboutSpec: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    resultRef: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    again: z.boolean().optional(),
    text: z.string().optional(),
  }),
});

export const InboxDelivered = defineEvent({
  type: "inbox.delivered",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    seqs: z.array(z.number().int()),
    as: z.enum(["steer", "turn", "prompt"]),
  }),
});

export const InboxDropped = defineEvent({
  type: "inbox.dropped",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    seqs: z.array(z.number().int()),
    reason: z.string(),
  }),
});

export const BudgetDenied = defineEvent({
  type: "budget.denied",
  durable: true,
  version: 1,
  schema: z.object({
    agentId: z.string().nullable(),
    dimension: z.enum(["spawnDepth", "maxAgents"]),
    remaining: z.number().int(),
  }),
});

// ── admission control (backpressure on provisioning) ────────────────────────
//
// Scope: provisioning only (Alineo.start()/parent.spawn(), cold-fork, CPU/IO-heavy) — composes
// with, does not replace, per-parent fork serialization. Namespaced under `agent`, not a
// standalone "admission" subject: these describe something happening to the spawning agent's own
// provisioning, the same way `budget.denied` above is namespaced by what it's about.

export const AgentAdmissionQueued = defineEvent({
  type: "agent.admission_queued",
  durable: true,
  version: 1,
  description:
    "No free provisioning slot was available, so the fork is held instead of run immediately. " +
    "Only emitted when a real wait happens — the common uncontended case emits nothing, to keep " +
    "this a signal for genuinely stuck spawns, not noise on every spawn.",
  schema: z.object({ agentId: z.string().nullable(), capacity: z.number().int() }),
});

export const AgentAdmissionGranted = defineEvent({
  type: "agent.admission_granted",
  durable: true,
  version: 1,
  description: "A held provisioning request got its slot and is proceeding.",
  schema: z.object({ agentId: z.string().nullable() }),
});

export const AgentAdmissionTimeout = defineEvent({
  type: "agent.admission_timeout",
  durable: true,
  version: 1,
  description:
    "A held provisioning request never got a slot within the bound and failed loudly instead " +
    "of hanging silently.",
  schema: z.object({ agentId: z.string().nullable(), waitedMs: z.number().int() }),
});

// ── agent supervision (failure policy) ───────────────────────────────────────

export const AgentTurnFailed = defineEvent({
  type: "agent.turn_failed",
  durable: true,
  version: 1,
  description:
    "A turn concluded in failure -- recorded before the failure-policy decision (settle, " +
    "auto-retry, or hold) is made, so the circuit breaker's consecutive-failure count is " +
    "accurate regardless of what's decided next.",
  schema: z.object({
    agentId: z.string().nullable(),
    error: z.string(),
    consecutiveFailures: z.number().int(),
  }),
});

export const AgentTurnInterrupted = defineEvent({
  type: "agent.turn_interrupted",
  durable: true,
  version: 1,
  description:
    "alineod found this agent still `running` on boot — its turn died with the previous " +
    "process, mid-stream, with no SDK around to report it. Recorded before the catch-up poll " +
    "that follows (`rehydrate.ts`'s `wasRunning` checks), so a turn a crash interrupted carries " +
    "an audit trail distinct from one that ran straight through, whatever catch-up later finds. " +
    "Named under `agent`, not `turn`: `turn.*` is reserved for events the harness itself " +
    "reports, and the harness has nothing to report here — the same reasoning that renamed " +
    "`turn.failed` to `agent.turn_failed`.",
  schema: z.object({ agentId: z.string().nullable() }),
});

export const AgentSupervisionNeeded = defineEvent({
  type: "agent.supervision_needed",
  durable: true,
  version: 1,
  description:
    "The agent is held (state: blocked) awaiting an operator decision: POST .../prompt to " +
    "retry (optionally with corrective text), POST .../stop to give up.",
  schema: z.object({
    agentId: z.string().nullable(),
    reason: z.enum(["ask", "retries-exhausted", "circuit-tripped"]),
    error: z.string(),
  }),
});
