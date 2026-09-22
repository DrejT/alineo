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
    "Something for this agent to be told — a notification, or a steer waiting for it to resume.",
  schema: z.object({
    agentId: z.string().nullable(),
    kind: z.enum(["notification", "steer"]),
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
