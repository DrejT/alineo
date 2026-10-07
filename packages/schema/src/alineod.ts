/**
 * alineod's wire contract, as Zod.
 *
 * Here rather than inside `apps/alineod` because three things need it and only one of them
 * is the daemon: alineod's own route validators, the emitted `apps/alineod/spec/openapi.json`,
 * and `alineo-mcp`, which talks to alineod over HTTP like any other client.
 *
 * `alineo-mcp` used to mirror eleven of these shapes by hand, documented as deliberate —
 * "typed against the wire contract, not against alineod's internal Zod schemas". That was a
 * fair objection while the schemas were an app's internals. It stops being one now the
 * contract is a published package, which is the whole reason this file moved.
 *
 * Types and Zod only. The routes, the projections and the engine stay in `apps/alineod`.
 */
import { z } from "zod";
import { allEvents } from "./define";
// Side-effect import: `allEvents()` is empty until the definitions have loaded, and an empty
// registry silently derives an empty event union rather than failing. This entry point is a
// separate bundle, so it has to load them itself.
import "./events";
import { AgentSpecSchema } from "./agent-spec";

/** The real spec, not a re-model. See `agent-spec.ts`. */
export const AgentSpec = AgentSpecSchema;

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
    idempotencyKey: z
      .string()
      .optional()
      .describe(
        "A retried request with the same key returns the original response instead of acting " +
          'twice. scope: "agent" only — a subtree op does not support per-request idempotency.',
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
    idempotencyKey: z
      .string()
      .optional()
      .describe(
        "A retried request with the same key returns the original response instead of acting " +
          'twice. scope: "agent" only — a subtree op does not support per-request idempotency.',
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
    idempotencyKey: z
      .string()
      .optional()
      .describe(
        "A retried delivery with the same key is not delivered twice, and returns the same " +
          'acknowledgement. scope: "agent" only — a subtree steer does not support ' +
          "per-request idempotency.",
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

// ── /agents/:id/memory, /facts, /compactions ─────────────────────────────────

/** Bounds enforced at the wire, so one request can't park an unbounded blob in the store. */
export const MEMORY_KEY_MAX_CHARS = 256;
export const MEMORY_VALUE_MAX_BYTES = 64 * 1024;
export const FACT_CONTENT_MAX_CHARS = 8 * 1024;

const ResourceRefView = z.object({
  resourceId: z.string(),
  teamId: z.string().optional(),
});

export const MemoryView = z.object({
  agentId: z.string(),
  resourceRef: ResourceRefView.describe(
    "The scope every memory call below is keyed by: the agent spec's `resourceId` (default: its " +
      "`name`) and `teamId`. Memory outlives the sandbox, so it stays readable after the agent ends.",
  ),
  semantic: z.boolean().describe("Whether semantic memory (facts) is configured on this alineod."),
  working: z
    .record(z.string(), z.unknown())
    .describe("One page of entries, in sorted key order. See `nextAfter`."),
  nextAfter: z
    .string()
    .optional()
    .describe("Present when more keys follow: pass it as `?after=` to read the next page."),
});

export const MemoryValueBody = z.object({
  // One `superRefine`, so the (potentially 64 KiB) value is serialized once for both checks.
  value: z.unknown().superRefine((v, ctx) => {
    if (v === undefined) {
      ctx.addIssue({ code: "custom", message: "value is required" });
      return;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(v);
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      ctx.addIssue({ code: "custom", message: "value must be JSON-serializable" });
    } else if (new TextEncoder().encode(json).byteLength > MEMORY_VALUE_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `value must be at most ${MEMORY_VALUE_MAX_BYTES} bytes as JSON`,
      });
    }
  }),
});

export const MemoryValueResponse = z.object({ key: z.string(), value: z.unknown() });

export const AddFactBody = z.object({
  content: z.string().min(1).max(FACT_CONTENT_MAX_CHARS),
  sourceRef: z
    .object({ sandboxId: z.string().min(1), entryIndex: z.number().int().nonnegative() })
    .optional()
    .describe(
      "Ties the fact to the ledger entry it came from. Only a fact with a `sourceRef` is " +
        "`verified` — that flag is computed, never caller-set.",
    ),
});

export const FactView = z.object({
  id: z.string().optional(),
  content: z.string(),
  sourceRef: z.object({ sandboxId: z.string(), entryIndex: z.number().int() }).optional(),
  verified: z.boolean().optional(),
  rememberedAt: z
    .number()
    .optional()
    .describe(
      "Epoch ms the fact was remembered. The shipped providers set it on every fact they " +
        "return, recall and listing alike; optional only because the contract doesn't promise " +
        "it of every possible provider.",
    ),
});

export const FactsResponse = z.object({
  agentId: z.string(),
  query: z.string().nullable().describe("Echo of `?query=`; null when listing every fact."),
  facts: z.array(FactView),
});

export const CompactionBody = z
  .object({
    maxFacts: z.number().int().positive().optional(),
    maxAgeMs: z.number().int().positive().optional(),
  })
  .describe("Both optional and combinable; neither set removes nothing.");

export const CompactionResultView = z.object({
  removed: z.number().int(),
  remaining: z.number().int(),
  summarized: z.number().int(),
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

// ── the event union (research/daemon.md §7) ─────────────────────────────────
//
// Derived from `@alineo-labs/schema`'s definitions rather than restated here. It used to be a
// second hand-maintained copy of the same sixteen events, and nothing checked that the two
// agreed — which is the duplication the schema package exists to end.
//
// Its only consumer is `scripts/emit-spec.ts`, so this is what puts alineod's events into
// `apps/alineod/spec/openapi.json`: a definition added to the schema shows up in the spec without
// anyone touching this file.
//
// Forwarded harness events (`tool.started`, `message.updated`, …) ride the same SSE stream
// tagged with `agentId`. They are defined in the schema too, under their own subjects, and
// are deliberately not in this union — it describes alineod's own agent-lifecycle events.

const ALINEOD_SUBJECTS = ["run", "agent", "handle", "wait", "inbox", "notify", "budget"];

/**
 * Every control-plane definition, as `{ event: "<type>", ...data }`.
 *
 * `definition.schema` is typed `z.ZodType` because a definition may hold any schema; every
 * event's is in fact an object, and `.extend()` needs that. Narrowed with `instanceof` rather
 * than an assertion, so a definition that ever stops being an object schema fails here loudly
 * instead of at parse time.
 */
function alineodEventMembers(): z.ZodObject[] {
  const members: z.ZodObject[] = [];
  for (const definition of allEvents()) {
    if (!ALINEOD_SUBJECTS.includes(definition.type.split(".")[0]!)) continue;
    if (!(definition.schema instanceof z.ZodObject)) {
      throw new Error(
        `Event "${definition.type}" is not defined with an object schema, so it cannot carry ` +
          `the "event" discriminator this union is built on.`,
      );
    }
    members.push(definition.schema.extend({ event: z.literal(definition.type) }));
  }
  if (members.length === 0) {
    // The registry is filled by import side effects, and an empty one derives an empty union
    // rather than failing — which once emptied `apps/alineod/spec/events.schema.json` silently.
    throw new Error(
      "No alineod event definitions are registered. Did this module load without ./events?",
    );
  }
  return members;
}

const [firstMember, ...restMembers] = alineodEventMembers();

export const AlineodEvent = z.discriminatedUnion("event", [firstMember!, ...restMembers]);
export type AlineodEvent = z.infer<typeof AlineodEvent>;
