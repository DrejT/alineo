/**
 * The wire contract, as Zod. One source of truth → route validators AND the emitted
 * `specs/alineod/openapi.json` + `events.schema.json` (research/daemon.md §2, §7).
 *
 * `AgentSpec` itself is validated by the SDK's own `validateAgentSpec()` inside `Alineo.start()`
 * / `.spawn()`, so here it's an opaque object — alineod does not re-model it.
 */
import { z } from "zod";

/** Opaque pass-through: the SDK owns `AgentSpec` validation. */
export const AgentSpec = z
  .record(z.string(), z.unknown())
  .describe("alineo AgentSpec (validated by the SDK)");

export const BudgetOverride = z
  .object({
    spawnDepth: z.number().int().nonnegative().optional(),
    maxAgents: z.number().int().nonnegative().optional(),
  })
  .describe("Overrides the spec's own spawnDepth / maxAgents (flag-beats-config).");

// ── POST /runs ────────────────────────────────────────────────────────────────

export const CreateRunBody = z.object({
  spec: AgentSpec,
  prompt: z.string().optional().describe("If set, drive one turn on the root agent after load."),
  budget: BudgetOverride.optional(),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const CreateRunResponse = z.object({
  runId: z.string(),
  rootAgentId: z.string(),
  state: z
    .string()
    .describe(
      'Always "provisioning" at return time (the route is async) — poll for the real state.',
    ),
});

// ── waits (spawn-time waitFor, POST /runs/:runId/await) ─────────────────────────

export const WaitMode = z
  .enum(["settled", "all", "any", "quorum"])
  .describe(
    "settled: every agent terminal, any outcome · all: every agent succeeded · any: the first to settle · quorum: k successes.",
  );

export const WaitForSpec = z.object({
  agents: z.array(z.string()).min(1),
  mode: WaitMode.optional(),
  k: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("quorum: how many successes are needed (default: all)."),
  onDepFailure: z
    .enum(["fail", "proceed"])
    .optional()
    .describe(
      "all / quorum: what a failed dependency (or an unreachable quorum) does. Default fail.",
    ),
  deadlineSec: z.number().positive().optional(),
  onDeadline: z
    .enum(["proceed", "fail"])
    .optional()
    .describe(
      "At the deadline: proceed with whatever settled (partial), or fail. Default proceed.",
    ),
});

export const RunAwaitBody = z
  .object({
    agents: z.array(z.string()).min(1).optional(),
    subtree: z
      .string()
      .optional()
      .describe("Wait for this agent's subtree to become quiescent instead."),
    mode: WaitMode.optional(),
    k: z.number().int().positive().optional(),
    onDepFailure: z.enum(["fail", "proceed"]).optional(),
    wait: z
      .number()
      .min(0)
      .optional()
      .describe("Seconds to hold the request (capped server-side)."),
  })
  .refine((b) => (b.agents ? !b.subtree : !!b.subtree), {
    message: "give exactly one of agents or subtree",
  });

export const RunAwaitResponse = z.object({
  outcome: z.enum(["satisfied", "partial", "depfail", "pending"]),
  selected: z.array(z.string()),
  settled: z.array(z.object({ agentId: z.string(), outcome: z.string().nullable() })),
  pending: z.array(z.string()),
});

export const QuiescenceView = z.object({
  rootAgentId: z.string(),
  quiescent: z
    .boolean()
    .describe(
      "Every member terminal and none still being spawned. Paused members count as not quiescent.",
    ),
  asOf: z.number(),
  members: z.array(
    z.object({
      agentId: z.string(),
      state: z.string(),
      outcome: z.string().nullable(),
      resultRef: z.string().nullable(),
    }),
  ),
  blockedOnPaused: z.array(z.string()),
});

// ── POST /runs/:runId/agents ──────────────────────────────────────────────────

export const SpawnAgentBody = z.object({
  spec: AgentSpec,
  parentAgentId: z.string(),
  waitFor: z
    .union([z.array(z.string()), WaitForSpec])
    .optional()
    .describe(
      'Hold the spawn until the named agents resolve (hold-then-spawn, D-c). A plain array means mode "settled": every agent terminal, any outcome.',
    ),
  prompt: z.string().optional(),
  notifyOn: z
    .array(z.string())
    .optional()
    .describe(
      "Tell this child when each named agent finishes, without blocking it (per-agent inbox): steered in if it's running, held while paused, prepended to its next prompt if idle.",
    ),
  budget: BudgetOverride.optional(),
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "D-f: a retried POST with the same key returns the original spawn instead of creating a second child.",
    ),
});
export type SpawnAgentBody = z.infer<typeof SpawnAgentBody>;

export const SpawnAgentResponse = z.object({
  agentId: z.string(),
  state: z
    .string()
    .describe('"spawning" if waitFor is set, else "provisioning" — poll for the real state.'),
});

// ── agent / tree views ───────────────────────────────────────────────────────

export const AgentView = z.object({
  agentId: z.string(),
  runId: z.string(),
  parentAgentId: z.string().nullable(),
  depth: z.number().int(),
  spawnIndex: z.number().int(),
  state: z.string(),
  specName: z.string(),
  sandboxId: z.string().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: z.string().nullable(),
  pausedBy: z
    .string()
    .nullable()
    .describe(
      'While paused: "operator" (it was the target) or "cascade" (a subtree pause reached it).',
    ),
});
export type AgentView = z.infer<typeof AgentView>;

export const TreeView = z.object({
  runId: z.string(),
  rootAgentId: z.string().nullable(),
  agents: z.array(AgentView),
  asOf: z.number().describe("Highest ledger seq reflected in this projection."),
});

export const AgentDetail = AgentView.extend({
  sessionStats: z.unknown().optional(),
});

// ── POST /agents/:id/{pause,resume} ─────────────────────────────────────────

export const ControlScopeBody = z
  .object({
    scope: z
      .enum(["agent", "subtree"])
      .default("agent")
      .describe(
        '"agent" (default): the named agent only. "subtree": the agent and every descendant — pause parents-first, resume children-first.',
      ),
  })
  .default({ scope: "agent" });

export const SubtreeOpResult = z
  .object({
    asOf: z.number().describe("Highest ledger seq when the subtree's membership was resolved."),
    results: z.array(
      z.object({
        agentId: z.string(),
        outcome: z.enum(["applied", "skipped", "failed"]),
        reason: z.string().optional(),
      }),
    ),
  })
  .describe("Best-effort, per member: one member failing doesn't undo or block the rest.");
export type SubtreeOpResult = z.infer<typeof SubtreeOpResult>;

// ── notifications (POST /agents/:id/notify-on, GET /agents/:id/inbox) ───────────

export const NotifyOnBody = z.object({
  agents: z.array(z.string()).min(1),
  wake: z
    .boolean()
    .optional()
    .describe(
      "If the subscriber is idle when a notification arrives, start a turn with it instead of queueing it.",
    ),
});

// ── POST /agents/:id/stop ────────────────────────────────────────────────────

export const StopAgentBody = z
  .object({
    mode: z.enum(["abort", "drain"]).default("abort"),
    scope: z
      .enum(["agent", "subtree"])
      .default("agent")
      .describe(
        '"subtree": the agent and every descendant, leaves first, with one result per member.',
      ),
  })
  .default({ mode: "abort", scope: "agent" });

// ── POST /agents/:id/prompt ──────────────────────────────────────────────────

export const PromptBody = z.object({ text: z.string().min(1) });

// ── POST /agents/:id/steer ───────────────────────────────────────────────────

export const SteerBody = z
  .object({
    message: z.string().min(1),
    scope: z
      .enum(["agent", "subtree"])
      .default("agent")
      .describe(
        '"subtree": deliver ONE message to this agent — your text plus a roster of its direct children — so it re-plans and redirects each child itself. Never a broadcast.',
      ),
  })
  .describe("Injected into the agent's current turn (research/swarm-control.md §8).");

export const SubtreeSteerResponse = z.object({
  deliveredAs: z
    .enum(["steer", "turn", "queued"])
    .describe(
      "steer: into its running turn · turn: a new turn (it was idle) · queued: it's paused; delivered on resume",
    ),
  roster: z.array(
    z.object({
      agentId: z.string(),
      sandboxId: z.string().nullable(),
      specName: z.string(),
      state: z.string(),
      outcome: z.string().nullable(),
    }),
  ),
});

// ── GET /agents/:id/result ───────────────────────────────────────────────────

export const ResultResponse = z.object({
  agentId: z.string(),
  state: z.enum(["pending", "settled"]),
  outcome: z.string().nullable(),
  resultRef: z.string().nullable(),
  result: z.string().nullable().describe("The result text, inline."),
});

// ── GET /agents/:id/transcript ───────────────────────────────────────────────

export const TranscriptMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    toolCalls: z.array(z.object({ name: z.string(), arguments: z.unknown() })),
    stopReason: z.string().nullable(),
    errorMessage: z.string().nullable(),
    thinking: z.string().optional().describe("Only with `?full=1`."),
  }),
  z.object({
    role: z.literal("tool"),
    toolName: z.string(),
    text: z.string(),
    isError: z.boolean(),
  }),
]);

export const TranscriptResponse = z.object({
  agentId: z.string(),
  turns: z.array(
    z.object({
      seq: z.number().int().describe("Ledger seq of the turn's `agent_end`."),
      ts: z.number().int().describe("Epoch ms."),
      messages: z.array(TranscriptMessage),
    }),
  ),
});

// ── the event union (research/daemon.md §7) ──────────────────────────────────
//
// alineod's own agent-lifecycle events. Forwarded harness events (`text`, `tool_start`, …)
// ride the same SSE stream tagged with `agentId` but are modelled by the SDK, not here.

const EventBase = z.object({ agentId: z.string().nullable() });

export const AlineodEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("run_started"), runId: z.string() }),
  EventBase.extend({
    event: z.literal("agent_spawned"),
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
        "Persisted (not just the spec) so rehydrate() can retry a still-pending spawn instead of losing it.",
      ),
    prompt: z.string().nullable().optional(),
  }),
  EventBase.extend({
    event: z.literal("agent_state_changed"),
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
    pausedBy: z
      .enum(["operator", "cascade"])
      .optional()
      .describe(
        "On a transition to paused: whether this agent was the target, or reached by a subtree pause.",
      ),
  }),
  EventBase.extend({
    event: z.literal("agent_provisioned"),
    sandboxId: z.string(),
  }).describe(
    "The sandbox now exists and the bridge is up — backfills what agent_spawned couldn't know yet.",
  ),
  EventBase.extend({
    event: z.literal("agent_steered"),
    message: z.string(),
    scope: z.enum(["agent", "subtree"]).optional(),
    roster: z.array(z.string()).optional(),
    deliveredAs: z.enum(["steer", "turn", "queued"]).optional(),
  }),
  EventBase.extend({
    event: z.literal("wait_resolved"),
    mode: WaitMode,
    outcome: z.enum(["satisfied", "partial", "deadline", "depfail"]),
    selected: z.array(z.string()),
    settled: z.array(z.object({ agentId: z.string(), outcome: z.string().nullable() })),
    pending: z.array(z.string()),
  }).describe(
    "A held spawn's waitFor resolved. depfail / deadline end the child failed without forking.",
  ),
  EventBase.extend({
    event: z.literal("wait_blocked_on_paused"),
    blockedOn: z.string(),
  }).describe(
    "A held spawn is still waiting on a dependency that's paused — emitted once per dependency.",
  ),
  EventBase.extend({
    event: z.literal("subtree_quiescent"),
    memberCount: z.number().int(),
    asOf: z.number(),
  }).describe(
    "The subtree rooted at agentId just became quiescent (only tracked while someone awaits it).",
  ),
  EventBase.extend({
    event: z.literal("notify_registered"),
    on: z.array(z.string()),
    wake: z.boolean(),
  }).describe("agentId subscribed to be told when each agent in `on` finishes."),
  EventBase.extend({
    event: z.literal("inbox_queued"),
    kind: z.enum(["notification", "steer"]),
    aboutAgentId: z.string().nullable().optional(),
    aboutSpec: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    resultRef: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    again: z.boolean().optional(),
    text: z.string().optional(),
  }).describe(
    "Something for agentId to be told — a notification, or a steer waiting for it to resume.",
  ),
  EventBase.extend({
    event: z.literal("inbox_delivered"),
    seqs: z.array(z.number().int()),
    as: z.enum(["steer", "turn", "prompt"]),
  }),
  EventBase.extend({
    event: z.literal("inbox_dropped"),
    seqs: z.array(z.number().int()),
    reason: z.string(),
  }),
  EventBase.extend({
    event: z.literal("agent_released"),
    reason: z.string(),
  }).describe(
    "A finished agent's still-open sandbox was closed (stop / DELETE /runs), or a fork that landed after its spawn was stopped. The recorded outcome is unchanged.",
  ),
  EventBase.extend({
    event: z.literal("agent_ended"),
    outcome: z.string(),
    endedAt: z.number(),
    error: z.string().optional(),
  }),
  EventBase.extend({
    event: z.literal("handle_settled"),
    outcome: z.string(),
    resultRef: z.string().nullable(),
  }),
  EventBase.extend({
    event: z.literal("budget_denied"),
    dimension: z.enum(["spawnDepth", "maxAgents"]),
    remaining: z.number().int(),
  }),
]);
export type AlineodEvent = z.infer<typeof AlineodEvent>;
